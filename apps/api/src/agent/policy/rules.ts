import type { ApprovalCategory, PolicyDecision, RiskLevel, ToolName } from '@nimbus/contracts';

import { classifyCommand } from '../commands/policy.js';
import { parsePatch } from '../tools/patch.js';
import { isProtectedPath } from '../tools/policy-paths.js';
import { POLICY_LIMITS } from './limits.js';

export interface Classification {
  decision: PolicyDecision;
  category: ApprovalCategory;
  risk: RiskLevel;
  reason: string;
  paths: string[];
  commandCategory?: string;
}

export const DEPENDENCY_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'go.mod',
  'Cargo.lock',
  'Cargo.toml',
  'Gemfile.lock',
];

export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'list_tree',
  'search_code',
  'read_file',
  'git_status',
  'message_user',
  'wait_for_user',
  'prepare_commit',
];

function allowed(reason: string, paths: string[] = []): Classification {
  return { decision: 'allowed', category: 'uncategorized_action', risk: 'low', reason, paths };
}

function needsApproval(
  category: ApprovalCategory,
  risk: RiskLevel,
  reason: string,
  paths: string[] = [],
): Classification {
  return { decision: 'approval_required', category, risk, reason, paths };
}

function denied(reason: string, paths: string[] = []): Classification {
  return { decision: 'denied', category: 'uncategorized_action', risk: 'high', reason, paths };
}

export function isDependencyFile(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  return DEPENDENCY_FILES.includes(name);
}

export function classifyPath(path: string): Classification | null {
  if (isDependencyFile(path)) {
    return needsApproval(
      'dependency_change',
      'high',
      'that file decides what code gets installed',
      [path],
    );
  }

  if (isProtectedPath(path)) {
    return needsApproval('protected_path_change', 'high', 'that path is protected', [path]);
  }
  return null;
}

function classifyPatch(patch: string): Classification {
  let files;

  try {
    files = parsePatch(patch);
  } catch {
    return denied('that patch could not be read');
  }

  const paths = files
    .map((file) => file.newPath ?? file.oldPath ?? '')
    .filter((path) => path !== '');

  const deleted = files.filter((file) => file.changeKind === 'deleted');
  const renamed = files.filter((file) => file.changeKind === 'renamed');
  const lines = files.reduce((total, file) => total + file.addedLines + file.removedLines, 0);

  for (const path of paths) {
    const found = classifyPath(path);

    if (found !== null) {
      return { ...found, paths };
    }
  }

  if (deleted.length > 0) {
    return needsApproval(
      'file_deletion',
      'medium',
      'that patch deletes a file',
      deleted.map((file) => file.oldPath ?? ''),
    );
  }

  if (renamed.length > 0) {
    return needsApproval(
      'file_rename',
      'medium',
      'that patch renames a file',
      renamed.map((file) => file.newPath ?? ''),
    );
  }

  if (
    files.length > POLICY_LIMITS.patchFilesBeforeApproval ||
    lines > POLICY_LIMITS.patchLinesBeforeApproval
  ) {
    return needsApproval(
      'oversized_diff',
      'medium',
      `that patch changes ${String(files.length)} files and ${String(lines)} lines`,
      paths,
    );
  }
  return allowed('ordinary files inside the workspace', paths);
}

function classifyCommandTool(input: unknown): Classification {
  const argv = (input as { argv?: unknown }).argv;

  if (!Array.isArray(argv) || argv.some((part) => typeof part !== 'string')) {
    return needsApproval('uncategorized_action', 'high', 'that command could not be read');
  }

  const found = classifyCommand(argv as string[]);
  const commandCategory = found.category ?? 'unknown';

  if (found.decision === 'denied') {
    return { ...denied(found.reason), commandCategory };
  }

  if (found.decision === 'approval_required') {
    return {
      ...needsApproval('lifecycle_scripts', 'high', found.reason),
      commandCategory,
    };
  }
  return { ...allowed(found.reason), commandCategory };
}

export function classifyAction(tool: string, input: unknown): Classification {
  if (READ_ONLY_TOOLS.includes(tool as ToolName)) {
    return allowed('that tool changes nothing outside the workspace');
  }

  if (tool === 'create_file') {
    const path = (input as { path?: unknown }).path;

    if (typeof path !== 'string') {
      return needsApproval('uncategorized_action', 'medium', 'that path could not be read');
    }
    return classifyPath(path) ?? allowed('a new ordinary file', [path]);
  }

  if (tool === 'apply_patch') {
    const patch = (input as { patch?: unknown }).patch;

    if (typeof patch !== 'string') {
      return needsApproval('uncategorized_action', 'medium', 'that patch could not be read');
    }
    return classifyPatch(patch);
  }

  if (tool === 'run_command' || tool === 'run_checks') {
    return classifyCommandTool(input);
  }

  return needsApproval(
    'uncategorized_action',
    'medium',
    'no rule covers that action, so a person has to look',
  );
}
