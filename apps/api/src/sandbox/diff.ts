import { DEFAULT_LIMITS, type PatchCaps } from '../config/limits.js';
import { SANDBOX_LIMITS } from './limits.js';
import type { PatchExport, PatchedFile } from './provider.js';
import { SandboxError } from './provider.js';

export const CONTEXT_LINES = 3;
export const NO_NEWLINE_MARKER = '\\ No newline at end of file';
export const DIFF_DP_MAX_LINES = 1_500;

type OperationKind = 'context' | 'add' | 'remove';

interface Operation {
  kind: OperationKind;
  text: string;
}

interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

export function splitLines(contents: string): { lines: string[]; endsWithNewline: boolean } {
  if (contents === '') {
    return { lines: [], endsWithNewline: true };
  }

  const endsWithNewline = contents.endsWith('\n');
  const body = endsWithNewline ? contents.slice(0, -1) : contents;
  return { lines: body.split('\n'), endsWithNewline };
}

function commonPrefixLength(before: readonly string[], after: readonly string[]): number {
  const limit = Math.min(before.length, after.length);
  let index = 0;

  while (index < limit && before[index] === after[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(
  before: readonly string[],
  after: readonly string[],
  floor: number,
): number {
  const limit = Math.min(before.length, after.length) - floor;
  let index = 0;

  while (index < limit && before[before.length - 1 - index] === after[after.length - 1 - index]) {
    index += 1;
  }
  return index;
}

function replaceWholly(before: readonly string[], after: readonly string[]): Operation[] {
  const operations: Operation[] = [];

  for (const text of before) {
    operations.push({ kind: 'remove', text });
  }
  for (const text of after) {
    operations.push({ kind: 'add', text });
  }
  return operations;
}

function middleOperations(before: readonly string[], after: readonly string[]): Operation[] {
  if (before.length === 0 || after.length === 0) {
    return replaceWholly(before, after);
  }

  if (before.length > DIFF_DP_MAX_LINES || after.length > DIFF_DP_MAX_LINES) {
    return replaceWholly(before, after);
  }

  const width = after.length + 1;
  const table = new Int32Array((before.length + 1) * width);

  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        before[row] === after[column]
          ? (table[(row + 1) * width + column + 1] ?? 0) + 1
          : Math.max(table[(row + 1) * width + column] ?? 0, table[row * width + column + 1] ?? 0);
    }
  }

  const operations: Operation[] = [];
  let row = 0;
  let column = 0;

  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      operations.push({ kind: 'context', text: before[row] ?? '' });
      row += 1;
      column += 1;
    } else if ((table[(row + 1) * width + column] ?? 0) >= (table[row * width + column + 1] ?? 0)) {
      operations.push({ kind: 'remove', text: before[row] ?? '' });
      row += 1;
    } else {
      operations.push({ kind: 'add', text: after[column] ?? '' });
      column += 1;
    }
  }

  while (row < before.length) {
    operations.push({ kind: 'remove', text: before[row] ?? '' });
    row += 1;
  }

  while (column < after.length) {
    operations.push({ kind: 'add', text: after[column] ?? '' });
    column += 1;
  }
  return operations;
}

export function diffLines(before: readonly string[], after: readonly string[]): Operation[] {
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);

  const operations: Operation[] = [];

  for (let index = 0; index < prefix; index += 1) {
    operations.push({ kind: 'context', text: before[index] ?? '' });
  }

  operations.push(
    ...middleOperations(
      before.slice(prefix, before.length - suffix),
      after.slice(prefix, after.length - suffix),
    ),
  );

  for (let index = before.length - suffix; index < before.length; index += 1) {
    operations.push({ kind: 'context', text: before[index] ?? '' });
  }
  return operations;
}

function buildHunks(operations: readonly Operation[]): Hunk[] {
  const changed: number[] = [];

  operations.forEach((operation, index) => {
    if (operation.kind !== 'context') {
      changed.push(index);
    }
  });

  if (changed.length === 0) {
    return [];
  }

  const ranges: { start: number; end: number }[] = [];

  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(operations.length - 1, index + CONTEXT_LINES);
    const last = ranges[ranges.length - 1];

    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const hunks: Hunk[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let cursor = 0;

  for (const range of ranges) {
    while (cursor < range.start) {
      const operation = operations[cursor];
      if (operation?.kind !== 'add') {
        beforeLine += 1;
      }
      if (operation?.kind !== 'remove') {
        afterLine += 1;
      }
      cursor += 1;
    }

    const hunk: Hunk = {
      beforeStart: beforeLine,
      beforeCount: 0,
      afterStart: afterLine,
      afterCount: 0,
      lines: [],
    };

    while (cursor <= range.end) {
      const operation = operations[cursor];
      if (operation === undefined) {
        break;
      }

      if (operation.kind === 'context') {
        hunk.lines.push(` ${operation.text}`);
        hunk.beforeCount += 1;
        hunk.afterCount += 1;
        beforeLine += 1;
        afterLine += 1;
      } else if (operation.kind === 'remove') {
        hunk.lines.push(`-${operation.text}`);
        hunk.beforeCount += 1;
        beforeLine += 1;
      } else {
        hunk.lines.push(`+${operation.text}`);
        hunk.afterCount += 1;
        afterLine += 1;
      }
      cursor += 1;
    }

    if (hunk.beforeCount === 0) {
      hunk.beforeStart = Math.max(0, hunk.beforeStart - 1);
    }
    if (hunk.afterCount === 0) {
      hunk.afterStart = Math.max(0, hunk.afterStart - 1);
    }
    hunks.push(hunk);
  }
  return hunks;
}

function lastLineIndex(lines: readonly string[], prefixes: string, text: string): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (prefixes.includes(line.charAt(0)) && line.slice(1) === text) {
      return index;
    }
  }
  return -1;
}

function markMissingNewlines(
  hunks: readonly Hunk[],
  before: { lines: string[]; endsWithNewline: boolean },
  after: { lines: string[]; endsWithNewline: boolean },
): void {
  const last = hunks[hunks.length - 1];
  if (last === undefined) {
    return;
  }

  const positions = new Set<number>();
  const beforeTail = before.lines[before.lines.length - 1];
  const afterTail = after.lines[after.lines.length - 1];

  if (!before.endsWithNewline && beforeTail !== undefined) {
    const index = lastLineIndex(last.lines, '- ', beforeTail);
    if (index !== -1) {
      positions.add(index);
    }
  }

  if (!after.endsWithNewline && afterTail !== undefined) {
    const index = lastLineIndex(last.lines, '+ ', afterTail);
    if (index !== -1) {
      positions.add(index);
    }
  }

  for (const index of [...positions].sort((left, right) => right - left)) {
    last.lines.splice(index + 1, 0, NO_NEWLINE_MARKER);
  }
}

export function unifiedDiff(
  path: string,
  beforeText: string | null,
  afterText: string | null,
): {
  text: string;
  addedLines: number;
  removedLines: number;
} {
  const before = splitLines(beforeText ?? '');
  const after = splitLines(afterText ?? '');
  const operations = diffLines(before.lines, after.lines);
  const hunks = buildHunks(operations);

  if (hunks.length === 0) {
    return { text: '', addedLines: 0, removedLines: 0 };
  }

  markMissingNewlines(hunks, before, after);

  const header = [`diff --git a/${path} b/${path}`];

  if (beforeText === null) {
    header.push('new file mode 100644', '--- /dev/null', `+++ b/${path}`);
  } else if (afterText === null) {
    header.push('deleted file mode 100644', `--- a/${path}`, '+++ /dev/null');
  } else {
    header.push(`--- a/${path}`, `+++ b/${path}`);
  }

  const body: string[] = [];
  let addedLines = 0;
  let removedLines = 0;

  for (const hunk of hunks) {
    body.push(
      `@@ -${String(hunk.beforeStart)},${String(hunk.beforeCount)} ` +
        `+${String(hunk.afterStart)},${String(hunk.afterCount)} @@`,
    );

    for (const line of hunk.lines) {
      body.push(line);
      if (line.startsWith('+')) {
        addedLines += 1;
      } else if (line.startsWith('-')) {
        removedLines += 1;
      }
    }
  }

  return { text: `${[...header, ...body].join('\n')}\n`, addedLines, removedLines };
}

export function buildPatch(
  baseline: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  caps: PatchCaps = DEFAULT_LIMITS,
): PatchExport {
  const paths = [...new Set([...baseline.keys(), ...current.keys()])].sort();
  const files: PatchedFile[] = [];
  const sections: string[] = [];

  let addedLines = 0;
  let removedLines = 0;

  for (const path of paths) {
    const before = baseline.get(path);
    const after = current.get(path);

    if (before === after) {
      continue;
    }

    const diff = unifiedDiff(path, before ?? null, after ?? null);
    if (diff.text === '') {
      continue;
    }

    const changeKind =
      before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified';

    files.push({
      path,
      changeKind,
      addedLines: diff.addedLines,
      removedLines: diff.removedLines,
    });

    sections.push(diff.text);
    addedLines += diff.addedLines;
    removedLines += diff.removedLines;
  }

  if (files.length > caps.maxChangedFiles) {
    throw new SandboxError('SANDBOX_PATCH_TOO_LARGE', 'This change touches too many files.');
  }

  if (addedLines + removedLines > caps.maxDiffLines) {
    throw new SandboxError('SANDBOX_PATCH_TOO_LARGE', 'This change is too large.');
  }

  const patch = sections.join('');
  const bytes = Buffer.byteLength(patch, 'utf8');

  if (bytes > SANDBOX_LIMITS.patchMaxBytes) {
    throw new SandboxError('SANDBOX_PATCH_TOO_LARGE', 'This change is too large.');
  }

  return { patch, files, addedLines, removedLines, bytes };
}
