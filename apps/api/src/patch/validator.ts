import {
  LIMITS,
  MAX_VALIDATED_FILES,
  MAX_VALIDATION_APPROVALS,
  MAX_VALIDATION_FINDINGS,
  PatchValidationReportSchema,
  type ApprovalCategory,
  type ApprovalEffect,
  type FileChangeKind,
  type PatchValidationReport,
  type ValidatedFile,
  type ValidationFinding,
  type ValidationFindingCode,
} from '@nimbus/contracts';

import { isProtectedPath } from '../agent/tools/policy-paths.js';
import { DEFAULT_LIMITS, type PatchCaps } from '../config/limits.js';
import { redactSecrets } from '../logging/redact.js';
import { SANDBOX_LIMITS } from '../sandbox/limits.js';
import { APPROVAL_CATEGORY_BY_FINDING, decisionFor, worstDecision } from './findings.js';
import {
  hasTraversal,
  isAbsolutePath,
  isNestedRepository,
  isSubmoduleFile,
  touchesGitDirectory,
} from './paths.js';
import {
  PatchParseError,
  SUBMODULE_MODE,
  SYMLINK_MODE,
  parsePatch,
  type ParsedFile,
} from './parse.js';
import { findNamedSecrets, findRandomLookingText } from './secrets.js';

export const SHA_SHOWN_CHARS = 12;

export const APPROVAL_REASONS: Readonly<Record<ApprovalCategory, string>> = {
  protected_path_change:
    'This change touches files that control how the repository is built or run.',
  file_deletion: 'This change deletes files.',
  file_rename: 'This change renames or moves files.',
  oversized_diff: 'This change is larger than the agreed limits.',
  dependency_change: 'This change alters dependencies.',
  lifecycle_scripts: 'This change enables package lifecycle scripts.',
  network_access: 'This change needs network access.',
  uncategorized_action: 'This change does something the policy does not cover on its own.',
};

export interface PatchValidationRequest {
  patch: string;
  expectedBaseSha: string;
  reportedBaseSha: string;
  limits?: PatchCaps;
}

interface Draft {
  findings: ValidationFinding[];
  files: ValidatedFile[];
}

function shorten(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > SHA_SHOWN_CHARS ? `${trimmed.slice(0, SHA_SHOWN_CHARS)}...` : trimmed;
}

function add(
  draft: Draft,
  code: ValidationFindingCode,
  paths: readonly string[],
  detail: string,
): void {
  if (draft.findings.length >= MAX_VALIDATION_FINDINGS) {
    return;
  }

  draft.findings.push({
    code,
    decision: decisionFor(code),
    paths: paths.slice(0, LIMITS.approvalPathsMax),
    detail,
  });
}

function changeKindOf(file: ParsedFile): FileChangeKind {
  if (file.renamed) {
    return 'renamed';
  }
  if (file.created) {
    return 'added';
  }
  if (file.deleted) {
    return 'deleted';
  }
  return 'modified';
}

function pathsOf(file: ParsedFile): string[] {
  const found: string[] = [];
  if (file.oldPath !== null) {
    found.push(file.oldPath);
  }
  if (file.newPath !== null && file.newPath !== file.oldPath) {
    found.push(file.newPath);
  }
  return found;
}

function checkPaths(draft: Draft, file: ParsedFile): void {
  for (const path of pathsOf(file)) {
    if (isAbsolutePath(path)) {
      add(
        draft,
        'PATH_ABSOLUTE',
        [path],
        'A changed path is absolute rather than inside the repository.',
      );
    }
    if (hasTraversal(path)) {
      add(draft, 'PATH_TRAVERSAL', [path], 'A changed path climbs outside the repository.');
    }
    if (touchesGitDirectory(path)) {
      add(
        draft,
        'PATH_GIT_DIRECTORY',
        [path],
        'A changed path is inside the Git directory itself.',
      );
    }
    if (isNestedRepository(path)) {
      add(draft, 'NESTED_REPOSITORY', [path], 'A changed path is inside a second repository.');
    }
    if (isSubmoduleFile(path)) {
      add(
        draft,
        'SUBMODULE_CHANGE',
        [path],
        'This change alters the submodules of the repository.',
      );
    }
  }
}

function checkModes(draft: Draft, file: ParsedFile, path: string): void {
  const modes = [file.oldMode, file.newMode].filter((mode): mode is string => mode !== null);

  if (modes.includes(SYMLINK_MODE)) {
    add(draft, 'SYMLINK_CHANGE', [path], 'This change creates or alters a symbolic link.');
    return;
  }

  if (modes.includes(SUBMODULE_MODE)) {
    add(draft, 'SUBMODULE_CHANGE', [path], 'This change creates or alters a submodule.');
    return;
  }

  if (
    file.oldMode !== null &&
    file.newMode !== null &&
    file.oldMode !== file.newMode &&
    !file.created &&
    !file.deleted
  ) {
    add(draft, 'MODE_CHANGE', [path], 'This change alters the permissions of a file.');
  }
}

function checkContent(draft: Draft, file: ParsedFile, path: string): void {
  if (file.binary) {
    add(draft, 'BINARY_FILE', [path], 'A changed file is not text and cannot be reviewed.');
    return;
  }

  const named = findNamedSecrets(file.addedText);
  const kinds = [...new Set(named.map((hit) => hit.name))];

  if (kinds.length > 0) {
    add(
      draft,
      'SECRET_DETECTED',
      [path],
      `An added line looks like a credential (${kinds.join(', ')}).`,
    );
    return;
  }

  if (findRandomLookingText(file.addedText).length > 0) {
    add(
      draft,
      'HIGH_ENTROPY_STRING',
      [path],
      'An added line contains a long random looking value that may be a credential.',
    );
  }
}

export function boundedDiff(lines: readonly string[]): { diff: string; diffTruncated: boolean } {
  const kept = lines.slice(0, LIMITS.fileDiffMaxLines);
  const overLines = kept.length < lines.length;
  const joined = redactSecrets(kept.join('\n'));

  if (joined.length <= LIMITS.fileDiffMaxChars) {
    return { diff: joined, diffTruncated: overLines };
  }

  return { diff: joined.slice(0, LIMITS.fileDiffMaxChars), diffTruncated: true };
}

function describeFile(file: ParsedFile, path: string): ValidatedFile {
  const previousPath = file.renamed && file.oldPath !== null ? file.oldPath : undefined;
  const guarded =
    isProtectedPath(path) || (previousPath !== undefined && isProtectedPath(previousPath));

  return {
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    changeKind: changeKindOf(file),
    addedLines: file.addedLines,
    removedLines: file.removedLines,
    protectedPath: guarded,
    ...boundedDiff(file.hunkLines),
  };
}

function buildApprovals(findings: readonly ValidationFinding[]): ApprovalEffect[] {
  const byCategory = new Map<ApprovalCategory, Set<string>>();

  for (const finding of findings) {
    if (finding.decision !== 'approval_required') {
      continue;
    }

    const category = APPROVAL_CATEGORY_BY_FINDING[finding.code];
    if (category === undefined) {
      continue;
    }

    const held = byCategory.get(category) ?? new Set<string>();
    for (const path of finding.paths) {
      held.add(path);
    }
    byCategory.set(category, held);
  }

  const effects: ApprovalEffect[] = [];

  for (const [category, paths] of byCategory) {
    if (effects.length >= MAX_VALIDATION_APPROVALS) {
      break;
    }

    effects.push({
      category,
      summary: `${category.replace(/_/g, ' ')} in ${String(paths.size)} file(s)`,
      paths: [...paths].slice(0, LIMITS.approvalPathsMax),
      reason: APPROVAL_REASONS[category],
      risk: category === 'protected_path_change' ? 'high' : 'medium',
    });
  }

  return effects;
}

function finish(
  baseCommitSha: string,
  bytes: number,
  draft: Draft,
  totals: { addedLines: number; removedLines: number; changedFiles: number },
): PatchValidationReport {
  const decision = worstDecision(draft.findings.map((finding) => finding.decision));

  return PatchValidationReportSchema.parse({
    decision,
    baseCommitSha,
    changedFiles: totals.changedFiles,
    addedLines: totals.addedLines,
    removedLines: totals.removedLines,
    bytes,
    files: draft.files.slice(0, MAX_VALIDATED_FILES),
    findings: draft.findings,
    approvals: decision === 'denied' ? [] : buildApprovals(draft.findings),
  });
}

export function validatePatch(request: PatchValidationRequest): PatchValidationReport {
  const bytes = Buffer.byteLength(request.patch, 'utf8');
  const draft: Draft = { findings: [], files: [] };
  const empty = { addedLines: 0, removedLines: 0, changedFiles: 0 };

  if (request.expectedBaseSha !== request.reportedBaseSha) {
    add(
      draft,
      'BASE_COMMIT_MISMATCH',
      [],
      `The changes were made from ${shorten(request.reportedBaseSha)}, not from the commit this session started at.`,
    );
    return finish(request.expectedBaseSha, bytes, draft, empty);
  }

  if (bytes > SANDBOX_LIMITS.patchMaxBytes) {
    add(draft, 'PATCH_TOO_LARGE', [], 'The changes are too large to review.');
    return finish(request.expectedBaseSha, bytes, draft, empty);
  }

  let parsed: ParsedFile[];

  try {
    parsed = parsePatch(request.patch);
  } catch (error) {
    add(
      draft,
      'PATCH_UNREADABLE',
      [],
      error instanceof PatchParseError ? error.message : 'The changes could not be read.',
    );
    return finish(request.expectedBaseSha, bytes, draft, empty);
  }

  let addedLines = 0;
  let removedLines = 0;

  for (const file of parsed) {
    const path = file.newPath ?? file.oldPath ?? '';

    if (path === '') {
      add(draft, 'PATCH_UNREADABLE', [], 'A changed file has no path.');
      continue;
    }

    addedLines += file.addedLines;
    removedLines += file.removedLines;

    checkPaths(draft, file);
    checkModes(draft, file, path);
    checkContent(draft, file, path);

    if (file.deleted) {
      add(draft, 'FILE_DELETED', [path], 'This change deletes a file.');
    }

    if (file.renamed) {
      add(draft, 'FILE_RENAMED', [path], 'This change renames or moves a file.');
    }

    const described = describeFile(file, path);

    if (described.protectedPath) {
      add(
        draft,
        'PROTECTED_PATH',
        [path],
        'This file controls how the repository is built or run.',
      );
    }

    draft.files.push(described);
  }

  const caps = request.limits ?? DEFAULT_LIMITS;

  if (parsed.length > caps.maxChangedFiles) {
    add(
      draft,
      'TOO_MANY_FILES',
      [],
      `This change touches ${String(parsed.length)} files, more than the limit of ${String(caps.maxChangedFiles)}.`,
    );
  }

  if (addedLines + removedLines > caps.maxDiffLines) {
    add(
      draft,
      'TOO_MANY_LINES',
      [],
      `This change alters ${String(addedLines + removedLines)} lines, more than the limit of ${String(caps.maxDiffLines)}.`,
    );
  }

  return finish(request.expectedBaseSha, bytes, draft, {
    addedLines,
    removedLines,
    changedFiles: parsed.length,
  });
}
