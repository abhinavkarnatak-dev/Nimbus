import type { FileChange, FileChangeKind } from '@nimbus/contracts';

import { bound, stripEscapes, RENDER_LIMITS } from '../render/safe.js';

export const DIFF_ROWS_MAX = 600;

export type DiffRowKind = 'hunk' | 'added' | 'removed' | 'context';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
}

export interface RenderedDiff {
  rows: readonly DiffRow[];
  truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const KIND_WORDS: Readonly<Record<FileChangeKind, string>> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
};

function kindOf(line: string): DiffRowKind {
  if (line.startsWith('@@')) {
    return 'hunk';
  }
  if (line.startsWith('+')) {
    return 'added';
  }
  if (line.startsWith('-')) {
    return 'removed';
  }
  return 'context';
}

export function diffRows(diff: string, cut = false): RenderedDiff {
  const lines = stripEscapes(diff).split('\n');
  const rows: DiffRow[] = [];

  let before = 0;
  let after = 0;

  for (const line of lines.slice(0, DIFF_ROWS_MAX)) {
    const kind = kindOf(line);

    if (kind === 'hunk') {
      const found = HUNK_HEADER.exec(line);
      before = Number(found?.[1] ?? 0);
      after = Number(found?.[2] ?? 0);
      rows.push({
        kind,
        text: bound(line, RENDER_LIMITS.lineMaxChars),
        beforeLine: null,
        afterLine: null,
      });
      continue;
    }

    const text = bound(line.slice(1), RENDER_LIMITS.lineMaxChars);

    if (kind === 'added') {
      rows.push({ kind, text, beforeLine: null, afterLine: after });
      after += 1;
      continue;
    }

    if (kind === 'removed') {
      rows.push({ kind, text, beforeLine: before, afterLine: null });
      before += 1;
      continue;
    }

    rows.push({ kind, text, beforeLine: before, afterLine: after });
    before += 1;
    after += 1;
  }

  return { rows, truncated: cut || lines.length > DIFF_ROWS_MAX };
}

export function changeWords(file: FileChange): string {
  return KIND_WORDS[file.changeKind];
}

export function fileName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

export function folderName(path: string): string {
  const parts = path.split('/');
  return parts.length === 1 ? '' : parts.slice(0, -1).join('/');
}

export function totalLines(files: readonly FileChange[]): { added: number; removed: number } {
  return files.reduce(
    (sum, one) => ({ added: sum.added + one.addedLines, removed: sum.removed + one.removedLines }),
    { added: 0, removed: 0 },
  );
}

export function barShare(file: FileChange): { added: number; removed: number } {
  const total = file.addedLines + file.removedLines;

  if (total === 0) {
    return { added: 0, removed: 0 };
  }

  return {
    added: Math.round((file.addedLines / total) * 100),
    removed: Math.round((file.removedLines / total) * 100),
  };
}
