import { DEFAULT_LIMITS, type PatchCaps } from '../../config/limits.js';
import { ToolError } from './errors.js';
import { TOOL_LIMITS } from './limits.js';

export const NO_NEWLINE_MARKER = '\\ No newline at end of file';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DEV_NULL = '/dev/null';

export type PatchChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface PatchHunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

export interface PatchFile {
  oldPath: string | null;
  newPath: string | null;
  changeKind: PatchChangeKind;
  hunks: PatchHunk[];
  addedLines: number;
  removedLines: number;
}

function stripPrefix(value: string): string {
  if (value === DEV_NULL) {
    return DEV_NULL;
  }

  const cleaned = value.split('\t')[0]?.trim() ?? '';
  return /^[ab]\//.test(cleaned) ? cleaned.slice(2) : cleaned;
}

function malformed(reason: string): ToolError {
  return new ToolError('PATCH_MALFORMED', `That patch could not be read: ${reason}.`);
}

function countedLines(hunk: PatchHunk): { before: number; after: number } {
  let before = 0;
  let after = 0;

  for (const line of hunk.lines) {
    const marker = line.charAt(0);

    if (marker === ' ') {
      before += 1;
      after += 1;
    } else if (marker === '-') {
      before += 1;
    } else if (marker === '+') {
      after += 1;
    }
  }
  return { before, after };
}

function finishFile(file: PatchFile | null, files: PatchFile[]): void {
  if (file === null) {
    return;
  }

  if (file.hunks.length === 0) {
    throw malformed('a file section had no changes');
  }

  for (const hunk of file.hunks) {
    const counted = countedLines(hunk);

    hunk.beforeCount = counted.before;
    hunk.afterCount = counted.after;
  }
  files.push(file);
}

export function parsePatch(patch: string, caps: PatchCaps = DEFAULT_LIMITS): PatchFile[] {
  if (patch.trim() === '') {
    throw malformed('it was empty');
  }

  if (Buffer.byteLength(patch, 'utf8') > TOOL_LIMITS.patchMaxBytes) {
    throw new ToolError('PATCH_TOO_LARGE', 'That patch is too large.');
  }

  const files: PatchFile[] = [];
  const rows = patch.replace(/\r\n/g, '\n').split('\n');

  if (rows[rows.length - 1] === '') {
    rows.pop();
  }

  let current: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let sawOldPath = false;

  for (const row of rows) {
    if (row.startsWith('diff --git ')) {
      finishFile(current, files);
      current = {
        oldPath: null,
        newPath: null,
        changeKind: 'modified',
        hunks: [],
        addedLines: 0,
        removedLines: 0,
      };
      hunk = null;
      sawOldPath = false;
      continue;
    }

    if (row.startsWith('--- ')) {
      if (current === null || sawOldPath) {
        finishFile(current, files);
        current = {
          oldPath: null,
          newPath: null,
          changeKind: 'modified',
          hunks: [],
          addedLines: 0,
          removedLines: 0,
        };
      }
      const value = stripPrefix(row.slice(4));
      current.oldPath = value === DEV_NULL ? null : value;
      sawOldPath = true;
      hunk = null;
      continue;
    }

    if (row.startsWith('+++ ')) {
      if (current === null || !sawOldPath) {
        throw malformed('a new path appeared without an old path');
      }
      const value = stripPrefix(row.slice(4));
      current.newPath = value === DEV_NULL ? null : value;

      if (current.oldPath === null && current.newPath === null) {
        throw malformed('a file section named no file at all');
      }

      current.changeKind =
        current.oldPath === null
          ? 'added'
          : current.newPath === null
            ? 'deleted'
            : current.oldPath === current.newPath
              ? 'modified'
              : 'renamed';
      continue;
    }

    const header = HUNK_HEADER.exec(row);
    if (header !== null) {
      if (current === null || !sawOldPath) {
        throw malformed('a hunk appeared before any file');
      }

      hunk = {
        beforeStart: Number(header[1]),
        beforeCount: header[2] === undefined ? 1 : Number(header[2]),
        afterStart: Number(header[3]),
        afterCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (hunk === null) {
      continue;
    }

    if (row === NO_NEWLINE_MARKER) {
      hunk.lines.push(row);
      continue;
    }

    const marker = row.charAt(0);
    if (marker === ' ' || marker === '-' || marker === '+') {
      hunk.lines.push(row);

      if (current !== null && marker === '+') {
        current.addedLines += 1;
      }
      if (current !== null && marker === '-') {
        current.removedLines += 1;
      }
      continue;
    }

    if (row === '') {
      hunk.lines.push(' ');
      continue;
    }
    hunk = null;
  }

  finishFile(current, files);

  if (files.length === 0) {
    throw malformed('it contained no file sections');
  }

  if (files.length > caps.maxChangedFiles) {
    throw new ToolError('PATCH_TOO_LARGE', 'That patch touches too many files.');
  }

  const changed = files.reduce((total, file) => total + file.addedLines + file.removedLines, 0);
  if (changed > caps.maxDiffLines) {
    throw new ToolError('PATCH_TOO_LARGE', 'That patch changes too many lines.');
  }
  return files;
}

function splitLines(contents: string): { lines: string[]; endsWithNewline: boolean } {
  if (contents === '') {
    return { lines: [], endsWithNewline: true };
  }

  const endsWithNewline = contents.endsWith('\n');
  const body = endsWithNewline ? contents.slice(0, -1) : contents;
  return { lines: body.split('\n'), endsWithNewline };
}

function mismatch(path: string, line: number): ToolError {
  return new ToolError(
    'PATCH_CONTEXT_MISMATCH',
    `That patch does not match the file at line ${String(line)}.`,
    { path },
  );
}

export function applyPatchToFile(file: PatchFile, original: string | null): string {
  const path = file.newPath ?? file.oldPath ?? '';
  const source = splitLines(original ?? '');
  const result: string[] = [];

  let cursor = 0;
  let endsWithNewline = source.endsWithNewline;

  const hunks = [...file.hunks].sort((left, right) => left.beforeStart - right.beforeStart);

  for (const hunk of hunks) {
    let start = Math.max(0, hunk.beforeStart - 1);

    if (start < cursor) {
      throw mismatch(path, hunk.beforeStart);
    }

    if (!hunkMatchesAt(source.lines, hunk, start)) {
      const located = locateHunk(source.lines, hunk, cursor);
      if (located === null) {
        throw mismatch(path, hunk.beforeStart);
      }
      start = located;
    }

    while (cursor < start) {
      result.push(source.lines[cursor] ?? '');
      cursor += 1;
    }

    let lastWasAfterSide = false;

    for (const row of hunk.lines) {
      if (row === NO_NEWLINE_MARKER) {
        if (lastWasAfterSide) {
          endsWithNewline = false;
        }
        continue;
      }

      const marker = row.charAt(0);
      const text = row.slice(1);

      if (marker === ' ' || marker === '-') {
        if (cursor >= source.lines.length || source.lines[cursor] !== text) {
          throw mismatch(path, cursor + 1);
        }
        cursor += 1;
      }

      if (marker === ' ' || marker === '+') {
        result.push(text);
        lastWasAfterSide = true;
      } else {
        lastWasAfterSide = false;
      }
    }
  }

  if (cursor < source.lines.length) {
    while (cursor < source.lines.length) {
      result.push(source.lines[cursor] ?? '');
      cursor += 1;
    }
    endsWithNewline = source.endsWithNewline;
  }

  if (result.length === 0) {
    return '';
  }
  return endsWithNewline ? `${result.join('\n')}\n` : result.join('\n');
}

function hunkMatchesAt(source: readonly string[], hunk: PatchHunk, start: number): boolean {
  let at = start;
  for (const row of hunk.lines) {
    const marker = row.charAt(0);
    if (marker !== ' ' && marker !== '-') continue;
    if (source[at] !== row.slice(1)) return false;
    at += 1;
  }
  return true;
}

function locateHunk(source: readonly string[], hunk: PatchHunk, from: number): number | null {
  let located: number | null = null;

  for (let at = from; at <= source.length; at += 1) {
    if (!hunkMatchesAt(source, hunk, at)) continue;
    if (located !== null) return null;
    located = at;
  }
  return located;
}
