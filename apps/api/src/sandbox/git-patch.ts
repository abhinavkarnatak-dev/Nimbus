import { DEFAULT_LIMITS, type PatchCaps } from '../config/limits.js';
import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError, type PatchExport, type PatchedFile } from './provider.js';

export const GIT_MARK_NEW_FILES: readonly string[] = [
  'git',
  '-C',
  SANDBOX_LIMITS.workspaceDir,
  'add',
  '--intent-to-add',
  '--all',
  '--',
];

export const GIT_EXPORT_DIFF: readonly string[] = [
  'git',
  '-C',
  SANDBOX_LIMITS.workspaceDir,
  '-c',
  'core.quotepath=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-renames',
  '--unified=3',
  '--',
];

export const GIT_IS_REPOSITORY: readonly string[] = [
  'git',
  '-C',
  SANDBOX_LIMITS.workspaceDir,
  'rev-parse',
  '--is-inside-work-tree',
];

export const GIT_INIT: readonly string[] = [
  'git',
  '-C',
  SANDBOX_LIMITS.workspaceDir,
  'init',
  '--quiet',
  '--initial-branch=nimbus-base',
];

export const GIT_STAGE_ALL: readonly string[] = [
  'git',
  '-C',
  SANDBOX_LIMITS.workspaceDir,
  'add',
  '--all',
  '--',
];

export const GIT_COMMIT_BASELINE: readonly string[] = [
  'git',
  '-C',
  SANDBOX_LIMITS.workspaceDir,
  '-c',
  'user.name=Nimbus',
  '-c',
  'user.email=nimbus@localhost',
  'commit',
  '--quiet',
  '--allow-empty',
  '--no-gpg-sign',
  '--message=base',
];

const FILE_HEADER = 'diff --git ';
const BINARY_MARKERS: readonly string[] = ['Binary files ', 'GIT binary patch'];

function pathFrom(line: string, prefix: string): string | null {
  const rest = line.slice(prefix.length);
  if (rest === '/dev/null') {
    return null;
  }

  if (rest.startsWith('"')) {
    throw new SandboxError(
      'SANDBOX_PATCH_FAILED',
      'A changed file has a name that cannot be handled safely.',
    );
  }

  const stripped = rest.startsWith('a/') || rest.startsWith('b/') ? rest.slice(2) : rest;
  if (stripped === '') {
    throw new SandboxError('SANDBOX_PATCH_FAILED', 'A changed file has no readable name.');
  }

  return stripped;
}

interface Draft {
  oldPath: string | null;
  newPath: string | null;
  created: boolean;
  deleted: boolean;
  addedLines: number;
  removedLines: number;
}

function finish(draft: Draft, files: PatchedFile[]): void {
  const path = draft.newPath ?? draft.oldPath;
  if (path === null) {
    throw new SandboxError('SANDBOX_PATCH_FAILED', 'A changed file has no readable name.');
  }

  const changeKind = draft.created ? 'added' : draft.deleted ? 'deleted' : 'modified';

  files.push({
    path,
    changeKind,
    addedLines: draft.addedLines,
    removedLines: draft.removedLines,
  });
}

export function summarizeUnifiedDiff(patch: string): {
  files: PatchedFile[];
  addedLines: number;
  removedLines: number;
} {
  const files: PatchedFile[] = [];
  let draft: Draft | null = null;
  let addedLines = 0;
  let removedLines = 0;
  let inHunk = false;

  for (const line of patch.split('\n')) {
    if (line.startsWith(FILE_HEADER)) {
      if (draft !== null) {
        finish(draft, files);
      }
      draft = {
        oldPath: null,
        newPath: null,
        created: false,
        deleted: false,
        addedLines: 0,
        removedLines: 0,
      };
      inHunk = false;
      continue;
    }

    if (draft === null) {
      continue;
    }

    if (BINARY_MARKERS.some((marker) => line.startsWith(marker))) {
      throw new SandboxError('SANDBOX_BINARY_FILE', 'A changed file is not text.');
    }

    if (!inHunk) {
      if (line.startsWith('new file mode ')) {
        draft.created = true;
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        draft.deleted = true;
        continue;
      }
      if (line.startsWith('--- ')) {
        draft.oldPath = pathFrom(line, '--- ');
        continue;
      }
      if (line.startsWith('+++ ')) {
        draft.newPath = pathFrom(line, '+++ ');
        continue;
      }
    }

    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith('+')) {
      draft.addedLines += 1;
      addedLines += 1;
      continue;
    }

    if (line.startsWith('-')) {
      draft.removedLines += 1;
      removedLines += 1;
    }
  }

  if (draft !== null) {
    finish(draft, files);
  }

  return { files, addedLines, removedLines };
}

export function buildGitPatchExport(patch: string, caps: PatchCaps = DEFAULT_LIMITS): PatchExport {
  const bytes = Buffer.byteLength(patch, 'utf8');

  if (bytes > SANDBOX_LIMITS.patchMaxBytes) {
    throw new SandboxError('SANDBOX_PATCH_TOO_LARGE', 'The changes are too large to export.');
  }

  const { files, addedLines, removedLines } = summarizeUnifiedDiff(patch);

  if (files.length > caps.maxChangedFiles) {
    throw new SandboxError('SANDBOX_PATCH_TOO_LARGE', 'Too many files were changed.');
  }

  if (addedLines + removedLines > caps.maxDiffLines) {
    throw new SandboxError('SANDBOX_PATCH_TOO_LARGE', 'Too many lines were changed.');
  }

  return { patch, files, addedLines, removedLines, bytes };
}
