import { isIgnoredPath } from '../tools/policy-paths.js';
import { CLONE_LIMITS, TREE_MODES } from './limits.js';
import { emptyStats, type CloneSkipReason, type CloneStats } from './source.js';

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  size?: number;
}

export interface PlannedFile {
  path: string;
  size: number;
}

export interface ClonePlan {
  files: PlannedFile[];
  stats: CloneStats;
}

export function skipReasonFor(
  entry: TreeEntry,
  bytesSoFar: number,
  taken: number,
): CloneSkipReason | null {
  if (entry.mode === TREE_MODES.symlink) {
    return 'symlink';
  }

  if (entry.mode === TREE_MODES.submodule || entry.type === 'commit') {
    return 'submodule';
  }

  if (isIgnoredPath(entry.path)) {
    return 'ignored_path';
  }

  const size = entry.size ?? 0;

  if (size > CLONE_LIMITS.maxFileBytes) {
    return 'too_large';
  }

  if (taken >= CLONE_LIMITS.maxFiles || bytesSoFar + size > CLONE_LIMITS.maxTotalBytes) {
    return 'budget_spent';
  }
  return null;
}

export function planClone(entries: readonly TreeEntry[]): ClonePlan {
  const stats = emptyStats();
  const files: PlannedFile[] = [];
  let bytes = 0;

  for (const entry of entries) {
    if (entry.type !== 'blob' && entry.type !== 'commit') {
      continue;
    }

    const reason = skipReasonFor(entry, bytes, files.length);

    if (reason !== null) {
      stats.skipped[reason] += 1;
      continue;
    }

    const size = entry.size ?? 0;
    files.push({ path: entry.path, size });
    bytes += size;
  }

  return { files, stats };
}
