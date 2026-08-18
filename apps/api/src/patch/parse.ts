export const REGULAR_MODE = '100644';
export const EXECUTABLE_MODE = '100755';
export const SYMLINK_MODE = '120000';
export const SUBMODULE_MODE = '160000';

export const KNOWN_MODES: readonly string[] = [
  REGULAR_MODE,
  EXECUTABLE_MODE,
  SYMLINK_MODE,
  SUBMODULE_MODE,
];

const FILE_HEADER = 'diff --git ';
const HUNK_HEADER = '@@';
const NO_NEWLINE = '\\';
const DEV_NULL = '/dev/null';

const BINARY_MARKERS: readonly string[] = ['Binary files ', 'GIT binary patch'];

const MODE_PATTERN = /^[0-7]{6}$/;

export interface ParsedFile {
  oldPath: string | null;
  newPath: string | null;
  created: boolean;
  deleted: boolean;
  renamed: boolean;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  addedLines: number;
  removedLines: number;
  addedText: string[];
  hunkLines: string[];
}

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchParseError';
  }
}

function unquotedPath(value: string): string {
  if (value.startsWith('"')) {
    throw new PatchParseError('A changed path is quoted and cannot be read safely.');
  }
  return value;
}

function stripPrefix(value: string, prefix: string): string {
  if (value === DEV_NULL) {
    return DEV_NULL;
  }
  if (!value.startsWith(prefix)) {
    throw new PatchParseError('A changed path does not use the expected form.');
  }
  return value.slice(prefix.length);
}

export function headerPaths(line: string): { oldPath: string; newPath: string } {
  const rest = unquotedPath(line.slice(FILE_HEADER.length));
  const halves = rest.split(' b/');

  if (halves.length !== 2 || !rest.startsWith('a/')) {
    throw new PatchParseError('A file header does not use the expected form.');
  }

  const oldPath = halves[0]?.slice('a/'.length) ?? '';
  const newPath = halves[1] ?? '';

  if (oldPath === '' || newPath === '') {
    throw new PatchParseError('A file header names an empty path.');
  }

  return { oldPath, newPath };
}

function readMode(value: string): string {
  const mode = value.trim();

  if (!MODE_PATTERN.test(mode)) {
    throw new PatchParseError('A file mode could not be read.');
  }

  return mode;
}

function blank(): ParsedFile {
  return {
    oldPath: null,
    newPath: null,
    created: false,
    deleted: false,
    renamed: false,
    binary: false,
    oldMode: null,
    newMode: null,
    addedLines: 0,
    removedLines: 0,
    addedText: [],
    hunkLines: [],
  };
}

function isContentLine(line: string): boolean {
  return (
    line === '' ||
    line.startsWith('+') ||
    line.startsWith('-') ||
    line.startsWith(' ') ||
    line.startsWith(NO_NEWLINE)
  );
}

export function parsePatch(patch: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;
  let inHunk = false;

  const lines = patch.split('\n');

  for (const line of lines) {
    if (line.startsWith(FILE_HEADER)) {
      if (current !== null) {
        files.push(current);
      }
      current = blank();
      const paths = headerPaths(line);
      current.oldPath = paths.oldPath;
      current.newPath = paths.newPath;
      inHunk = false;
      continue;
    }

    if (current === null) {
      if (line.trim() === '') {
        continue;
      }
      throw new PatchParseError('The patch does not begin with a file header.');
    }

    if (line.startsWith(HUNK_HEADER)) {
      inHunk = true;
      current.hunkLines.push(line);
      continue;
    }

    if (!inHunk) {
      if (BINARY_MARKERS.some((marker) => line.startsWith(marker))) {
        current.binary = true;
        continue;
      }
      if (line.startsWith('new file mode ')) {
        current.created = true;
        current.newMode = readMode(line.slice('new file mode '.length));
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        current.deleted = true;
        current.oldMode = readMode(line.slice('deleted file mode '.length));
        continue;
      }
      if (line.startsWith('old mode ')) {
        current.oldMode = readMode(line.slice('old mode '.length));
        continue;
      }
      if (line.startsWith('new mode ')) {
        current.newMode = readMode(line.slice('new mode '.length));
        continue;
      }
      if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
        current.renamed = true;
        current.oldPath = unquotedPath(line.slice(line.indexOf('from ') + 'from '.length));
        continue;
      }
      if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
        current.renamed = true;
        current.newPath = unquotedPath(line.slice(line.indexOf('to ') + 'to '.length));
        continue;
      }
      if (line.startsWith('index ')) {
        const trailing = line.slice('index '.length).split(' ')[1];
        if (trailing !== undefined && trailing.trim() !== '') {
          const mode = readMode(trailing);
          current.oldMode ??= mode;
          current.newMode ??= mode;
        }
        continue;
      }
      if (line.startsWith('--- ')) {
        const path = stripPrefix(unquotedPath(line.slice('--- '.length)), 'a/');
        current.oldPath = path === DEV_NULL ? null : path;
        if (path === DEV_NULL) {
          current.created = true;
        }
        continue;
      }
      if (line.startsWith('+++ ')) {
        const path = stripPrefix(unquotedPath(line.slice('+++ '.length)), 'b/');
        current.newPath = path === DEV_NULL ? null : path;
        if (path === DEV_NULL) {
          current.deleted = true;
        }
        continue;
      }
      if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) {
        continue;
      }
      if (line.trim() === '') {
        continue;
      }
      throw new PatchParseError('The patch contains a header line that could not be read.');
    }

    if (!isContentLine(line)) {
      throw new PatchParseError('The patch contains a line that is neither header nor content.');
    }

    current.hunkLines.push(line);

    if (line.startsWith('+')) {
      current.addedLines += 1;
      current.addedText.push(line.slice(1));
      continue;
    }

    if (line.startsWith('-')) {
      current.removedLines += 1;
    }
  }

  if (current !== null) {
    files.push(current);
  }

  return files;
}
