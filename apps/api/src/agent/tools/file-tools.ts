import { DEFAULT_LIMITS, type PatchCaps } from '../../config/limits.js';
import type { Sandbox, WorkspaceEntryKind } from '../../sandbox/index.js';
import { ToolError } from './errors.js';
import { TOOL_LIMITS } from './limits.js';
import { applyPatchToFile, parsePatch, type PatchChangeKind } from './patch.js';
import { isIgnoredPath, isProtectedPath } from './policy-paths.js';
import {
  type WorkspaceIndex,
  assertReadable,
  assertRegularFile,
  buildIndex,
  type ResolvedPath,
} from './resolve.js';
import { clipLine, isProbablyText } from './text.js';

export interface TreeEntry {
  path: string;
  kind: WorkspaceEntryKind;
  size: number;
}

export interface ListTreeInput {
  path?: string;
  maxEntries?: number;
}

export interface ListTreeResult {
  entries: TreeEntry[];
  totalMatched: number;
  hiddenByPolicy: number;
  truncated: boolean;
}

export interface SearchCodeInput {
  query: string;
  caseSensitive?: boolean;
  pathPrefix?: string;
  maxMatches?: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  lineTruncated: boolean;
}

export interface SearchCodeResult {
  matches: SearchMatch[];
  filesScanned: number;
  filesSkipped: number;
  truncated: boolean;
}

export interface ReadFileInput {
  path: string;
  startLine?: number;
  lineCount?: number;
}

export interface ReadFileResult {
  path: string;
  contents: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  isProtected: boolean;
}

export interface CreateFileInput {
  path: string;
  contents: string;
}

export interface CreateFileResult {
  path: string;
  bytes: number;
  isProtected: boolean;
}

export interface EditFileInput {
  path: string;
  oldText: string;
  newText: string;
}

export interface EditFileResult {
  path: string;
  replacements: number;
  addedLines: number;
  removedLines: number;
  isProtected: boolean;
}

export interface DeleteFileInput {
  path: string;
}

export interface MoveFileInput {
  from: string;
  to: string;
}

export interface WorkspaceChangeResult {
  path: string;
  previousPath: string | null;
  isProtected: boolean;
}

export interface ApplyPatchInput {
  patch: string;
}

export interface AppliedFile {
  path: string;
  previousPath: string | null;
  changeKind: PatchChangeKind;
  addedLines: number;
  removedLines: number;
  isProtected: boolean;
}

export interface ApplyPatchResult {
  files: AppliedFile[];
  addedLines: number;
  removedLines: number;
  protectedPaths: string[];
}

function boundedCount(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) {
    return ceiling;
  }

  if (!Number.isInteger(requested) || requested < 1) {
    throw new ToolError('SEARCH_INVALID', 'That count is not usable.');
  }
  return Math.min(requested, ceiling);
}

function isVisibleFile(index: WorkspaceIndex, path: string): boolean {
  if (isIgnoredPath(path)) {
    return false;
  }

  try {
    const resolved = index.resolve(path);
    return resolved.path === path && resolved.kind === 'file';
  } catch {
    return false;
  }
}

function listable(index: WorkspaceIndex, prefix: string | null): TreeEntry[] {
  const entries: TreeEntry[] = [];

  for (const entry of index.all()) {
    if (isIgnoredPath(entry.path)) {
      continue;
    }

    if (prefix !== null && entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) {
      continue;
    }

    if (entry.path.split('/').length > TOOL_LIMITS.treeMaxDepth) {
      continue;
    }

    try {
      const resolved = index.resolve(entry.path);

      if (entry.kind === 'symlink' && resolved.kind === 'missing') {
        continue;
      }
    } catch {
      continue;
    }
    entries.push({ path: entry.path, kind: entry.kind, size: entry.size });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function listTree(
  sandbox: Sandbox,
  input: ListTreeInput = {},
): Promise<ListTreeResult> {
  const index = await buildIndex(sandbox);
  const prefix = input.path === undefined ? null : index.resolve(input.path).path;

  if (prefix !== null && isIgnoredPath(prefix)) {
    throw new ToolError('PATH_IGNORED', 'That path is not available to the agent.', {
      path: prefix,
    });
  }

  const visible = listable(index, prefix);
  const everything = index.all().filter((entry) => {
    if (prefix === null) {
      return true;
    }
    return entry.path === prefix || entry.path.startsWith(`${prefix}/`);
  });

  const limit = boundedCount(input.maxEntries, TOOL_LIMITS.treeMaxEntries);

  return {
    entries: visible.slice(0, limit),
    totalMatched: visible.length,
    hiddenByPolicy: everything.length - visible.length,
    truncated: visible.length > limit,
  };
}

export async function searchCode(
  sandbox: Sandbox,
  input: SearchCodeInput,
): Promise<SearchCodeResult> {
  const query = input.query;

  if (query === '' || query.length > TOOL_LIMITS.searchQueryMaxChars) {
    throw new ToolError('SEARCH_INVALID', 'That search text is not usable.');
  }

  const index = await buildIndex(sandbox);
  const prefix = input.pathPrefix === undefined ? null : index.resolve(input.pathPrefix).path;
  const limit = boundedCount(input.maxMatches, TOOL_LIMITS.searchMaxMatches);
  const needle = input.caseSensitive === true ? query : query.toLowerCase();

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  let truncated = false;

  for (const entry of index.files()) {
    if (filesScanned >= TOOL_LIMITS.searchMaxFilesScanned) {
      truncated = true;
      break;
    }

    if (prefix !== null && !entry.path.startsWith(prefix)) {
      continue;
    }

    if (!isVisibleFile(index, entry.path)) {
      filesSkipped += 1;
      continue;
    }

    let contents: string;
    try {
      contents = await sandbox.readFile(entry.path);
    } catch {
      filesSkipped += 1;
      continue;
    }

    if (!isProbablyText(contents)) {
      filesSkipped += 1;
      continue;
    }

    filesScanned += 1;
    const lines = contents.split('\n');

    for (let number = 0; number < lines.length; number += 1) {
      const raw = lines[number] ?? '';
      const haystack = input.caseSensitive === true ? raw : raw.toLowerCase();

      if (!haystack.includes(needle)) {
        continue;
      }

      if (matches.length >= limit) {
        truncated = true;
        break;
      }

      const clipped = clipLine(raw, TOOL_LIMITS.searchMaxLineChars);
      matches.push({
        path: entry.path,
        line: number + 1,
        text: clipped.text,
        lineTruncated: clipped.truncated,
      });
    }

    if (truncated) {
      break;
    }
  }

  return { matches, filesScanned, filesSkipped, truncated };
}

export async function readFile(sandbox: Sandbox, input: ReadFileInput): Promise<ReadFileResult> {
  const index = await buildIndex(sandbox);
  const resolved = index.resolve(input.path);

  assertReadable(resolved);
  assertRegularFile(resolved);

  const entry = index.get(resolved.path);
  if (entry !== undefined && entry.size > TOOL_LIMITS.readMaxBytes) {
    throw new ToolError('FILE_TOO_LARGE', 'That file is too large to read.', {
      path: input.path,
    });
  }

  const contents = await sandbox.readFile(resolved.path);

  if (!isProbablyText(contents)) {
    throw new ToolError('FILE_NOT_TEXT', 'That file is not text.', { path: input.path });
  }

  if (Buffer.byteLength(contents, 'utf8') > TOOL_LIMITS.readMaxBytes) {
    throw new ToolError('FILE_TOO_LARGE', 'That file is too large to read.', {
      path: input.path,
    });
  }

  const lines = contents.split('\n');
  const totalLines = lines.length;
  const startLine = input.startLine ?? 1;

  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new ToolError('SEARCH_INVALID', 'That starting line is not usable.', {
      path: input.path,
    });
  }

  const count = boundedCount(input.lineCount, TOOL_LIMITS.readMaxLines);
  const slice = lines.slice(startLine - 1, startLine - 1 + count);
  const endLine = Math.min(totalLines, startLine - 1 + slice.length);

  return {
    path: resolved.path,
    contents: slice.join('\n'),
    startLine,
    endLine,
    totalLines,
    truncated: endLine < totalLines || startLine > 1,
    isProtected: resolved.protected,
  };
}

export async function createFile(
  sandbox: Sandbox,
  input: CreateFileInput,
): Promise<CreateFileResult> {
  const index = await buildIndex(sandbox);
  const resolved = index.resolve(input.path);

  assertReadable(resolved);

  if (resolved.kind !== 'missing') {
    throw new ToolError('FILE_EXISTS', 'That file already exists.', { path: input.path });
  }

  const bytes = Buffer.byteLength(input.contents, 'utf8');
  if (bytes > TOOL_LIMITS.createMaxBytes) {
    throw new ToolError('FILE_TOO_LARGE', 'That file is too large to create.', {
      path: input.path,
    });
  }

  if (!isProbablyText(input.contents)) {
    throw new ToolError('FILE_NOT_TEXT', 'Only text files can be created.', {
      path: input.path,
    });
  }

  await sandbox.writeFile(resolved.path, input.contents);
  return { path: resolved.path, bytes, isProtected: resolved.protected };
}

export async function editFile(sandbox: Sandbox, input: EditFileInput): Promise<EditFileResult> {
  if (input.oldText === '') {
    throw new ToolError('EDIT_INVALID', 'The text to replace cannot be empty.', {
      path: input.path,
    });
  }

  const index = await buildIndex(sandbox);
  const resolved = index.resolve(input.path);
  assertReadable(resolved);
  assertRegularFile(resolved);
  const original = await sandbox.readFile(resolved.path);

  if (!isProbablyText(original)) {
    throw new ToolError('FILE_NOT_TEXT', 'Only text files can be edited.', { path: input.path });
  }
  if (
    Buffer.byteLength(input.oldText, 'utf8') > TOOL_LIMITS.editMaxBytes ||
    Buffer.byteLength(input.newText, 'utf8') > TOOL_LIMITS.editMaxBytes
  ) {
    throw new ToolError('EDIT_TOO_LARGE', 'That replacement is too large.', { path: input.path });
  }

  const first = original.indexOf(input.oldText);
  if (first < 0) {
    throw new ToolError('EDIT_NOT_FOUND', 'The exact text to replace was not found.', {
      path: input.path,
    });
  }
  if (original.includes(input.oldText, first + 1)) {
    throw new ToolError(
      'EDIT_NOT_UNIQUE',
      'The exact text appears more than once; use a larger context.',
      { path: input.path },
    );
  }

  await sandbox.writeFile(
    resolved.path,
    `${original.slice(0, first)}${input.newText}${original.slice(first + input.oldText.length)}`,
  );
  return {
    path: resolved.path,
    replacements: 1,
    addedLines: input.newText.split('\n').length - 1,
    removedLines: input.oldText.split('\n').length - 1,
    isProtected: resolved.protected,
  };
}

export async function deleteFile(
  sandbox: Sandbox,
  input: DeleteFileInput,
): Promise<WorkspaceChangeResult> {
  const index = await buildIndex(sandbox);
  const resolved = index.resolve(input.path);
  assertReadable(resolved);
  assertRegularFile(resolved);
  await sandbox.removeFile(resolved.path);
  return { path: resolved.path, previousPath: null, isProtected: resolved.protected };
}

export async function moveFile(
  sandbox: Sandbox,
  input: MoveFileInput,
): Promise<WorkspaceChangeResult> {
  const index = await buildIndex(sandbox);
  const from = index.resolve(input.from);
  const to = index.resolve(input.to);
  assertReadable(from);
  assertRegularFile(from);
  assertReadable(to);
  if (to.kind !== 'missing') {
    throw new ToolError('FILE_EXISTS', 'The destination file already exists.', { path: input.to });
  }
  const contents = await sandbox.readFile(from.path);
  if (!isProbablyText(contents)) {
    throw new ToolError('FILE_NOT_TEXT', 'Binary files cannot be moved by this tool.', {
      path: input.from,
    });
  }
  await sandbox.writeFile(to.path, contents);
  try {
    await sandbox.removeFile(from.path);
  } catch (error) {
    try {
      await sandbox.removeFile(to.path);
    } catch {
      // Preserve the original failure; the workspace provider may be unavailable for cleanup.
    }
    throw new ToolError('MOVE_FAILED', 'The source could not be removed after copying.', {
      path: input.from,
      cause: error,
    });
  }
  return {
    path: to.path,
    previousPath: from.path,
    isProtected: from.protected || to.protected,
  };
}

function checkedPatchPath(index: WorkspaceIndex, path: string): ResolvedPath {
  const resolved = index.resolve(path);

  if (isIgnoredPath(resolved.path)) {
    throw new ToolError('PATH_IGNORED', 'That path is not available to the agent.', { path });
  }
  return resolved;
}

export async function applyPatch(
  sandbox: Sandbox,
  input: ApplyPatchInput,
  caps: PatchCaps = DEFAULT_LIMITS,
  approvedByUser = false,
): Promise<ApplyPatchResult> {
  const index = await buildIndex(sandbox);
  const parsed = parsePatch(input.patch, caps);

  const planned: { file: AppliedFile; contents: string | null }[] = [];

  for (const file of parsed) {
    if ((file.changeKind === 'deleted' || file.changeKind === 'renamed') && !approvedByUser) {
      throw new ToolError(
        'PATCH_APPROVAL_REQUIRED',
        file.changeKind === 'renamed'
          ? 'Renaming a file needs a separate approval.'
          : 'Deleting a file needs a separate approval.',
        { path: file.oldPath ?? '' },
      );
    }

    const oldResolved = file.oldPath === null ? null : checkedPatchPath(index, file.oldPath);
    const newResolved = file.newPath === null ? null : checkedPatchPath(index, file.newPath);

    if (oldResolved !== null && oldResolved.kind !== 'file') {
      throw new ToolError('FILE_NOT_FOUND', 'That patch changes a file that is not there.', {
        path: file.oldPath ?? '',
      });
    }

    if (file.changeKind === 'deleted') {
      if (oldResolved === null) {
        throw new ToolError('PATCH_MALFORMED', 'That patch could not be read: no source file.');
      }
      planned.push({
        file: {
          path: oldResolved.path,
          previousPath: null,
          changeKind: 'deleted',
          addedLines: file.addedLines,
          removedLines: file.removedLines,
          isProtected: oldResolved.protected,
        },
        contents: null,
      });
      continue;
    }

    if (newResolved === null) {
      throw new ToolError('PATCH_MALFORMED', 'That patch could not be read: no target file.');
    }

    if (file.changeKind === 'renamed' && newResolved.kind !== 'missing') {
      throw new ToolError(
        'FILE_EXISTS',
        'That patch renames a file onto an existing destination.',
        {
          path: file.newPath ?? '',
        },
      );
    }

    if (file.changeKind === 'added' && newResolved.kind !== 'missing') {
      throw new ToolError('FILE_EXISTS', 'That patch creates a file that already exists.', {
        path: file.newPath ?? '',
      });
    }

    const original = oldResolved === null ? null : await sandbox.readFile(oldResolved.path);

    planned.push({
      file: {
        path: newResolved.path,
        previousPath: file.changeKind === 'renamed' ? (oldResolved?.path ?? null) : null,
        changeKind: file.changeKind,
        addedLines: file.addedLines,
        removedLines: file.removedLines,
        isProtected: oldResolved?.protected === true || isProtectedPath(newResolved.path),
      },
      contents: applyPatchToFile(file, original),
    });
  }

  const applied: AppliedFile[] = [];

  for (const step of planned) {
    if (step.file.changeKind === 'deleted') {
      await sandbox.removeFile(step.file.path);
    } else {
      await sandbox.writeFile(step.file.path, step.contents ?? '');
      if (step.file.changeKind === 'renamed' && step.file.previousPath !== null) {
        try {
          await sandbox.removeFile(step.file.previousPath);
        } catch (error) {
          try {
            await sandbox.removeFile(step.file.path);
          } catch {
            // Preserve the original failure; the provider may be unavailable for cleanup.
          }
          throw new ToolError('MOVE_FAILED', 'The source could not be removed after renaming.', {
            path: step.file.previousPath,
            cause: error,
          });
        }
      }
    }
    applied.push(step.file);
  }

  return {
    files: applied,
    addedLines: applied.reduce((total, file) => total + file.addedLines, 0),
    removedLines: applied.reduce((total, file) => total + file.removedLines, 0),
    protectedPaths: applied.filter((file) => file.isProtected).map((file) => file.path),
  };
}
