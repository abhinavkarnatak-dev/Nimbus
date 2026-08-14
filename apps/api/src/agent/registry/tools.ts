import {
  CheckKindSchema,
  CheckResultSchema,
  LIMITS,
  WorkspacePathSchema,
  type ToolOutcome,
} from '@nimbus/contracts';
import { z } from 'zod';

import { applyPatch, createFile, listTree, readFile, searchCode } from '../tools/file-tools.js';
import { defineTool, type ToolDefinition } from './definition.js';
import { REGISTRY_LIMITS } from './limits.js';

const boundedCount = z.int().positive().max(1_000);
const argv = z.array(z.string().min(1).max(4_096)).min(1).max(64);

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= REGISTRY_LIMITS.outputMaxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, REGISTRY_LIMITS.outputMaxChars), truncated: true };
}

function shorten(text: string): string {
  return text.slice(0, REGISTRY_LIMITS.summaryMaxChars);
}

function only<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

export const listTreeTool = defineTool({
  name: 'list_tree',
  description: 'List files and folders in the workspace, skipping anything the agent may not read.',
  timeoutMs: REGISTRY_LIMITS.readTimeoutMs,
  input: z.strictObject({
    path: WorkspacePathSchema.optional().describe('a folder to list, or omit for the whole tree'),
    maxEntries: boundedCount.optional().describe('how many entries to return at most'),
  }),
  run: async (input, context) => {
    const result = await listTree(context.sandbox, {
      ...only('path', input.path),
      ...only('maxEntries', input.maxEntries),
    });

    const clipped = clip(result.entries.map((entry) => `${entry.path} (${entry.kind})`).join('\n'));

    return {
      summary: shorten(
        `entries: ${String(result.entries.length)}, hidden by policy: ${String(result.hiddenByPolicy)}`,
      ),
      paths: result.entries.slice(0, REGISTRY_LIMITS.pathsPerRecordMax).map((entry) => entry.path),
      text: clipped.text,
      truncated: clipped.truncated || result.truncated,
    };
  },
});

export const searchCodeTool = defineTool({
  name: 'search_code',
  description: 'Find lines in the workspace that contain a piece of text.',
  timeoutMs: REGISTRY_LIMITS.searchTimeoutMs,
  input: z.strictObject({
    query: z.string().min(1).max(200).describe('the text to look for'),
    caseSensitive: z.boolean().optional(),
    pathPrefix: WorkspacePathSchema.optional().describe('only search under this folder'),
    maxMatches: boundedCount.optional(),
  }),
  run: async (input, context) => {
    const result = await searchCode(context.sandbox, {
      query: input.query,
      ...only('caseSensitive', input.caseSensitive),
      ...only('pathPrefix', input.pathPrefix),
      ...only('maxMatches', input.maxMatches),
    });

    const clipped = clip(
      result.matches
        .map((match) => `${match.path}:${String(match.line)}: ${match.text}`)
        .join('\n'),
    );

    return {
      summary: shorten(
        `matches: ${String(result.matches.length)} in ${String(result.filesScanned)} files`,
      ),
      paths: [...new Set(result.matches.map((match) => match.path))].slice(
        0,
        REGISTRY_LIMITS.pathsPerRecordMax,
      ),
      text: clipped.text,
      truncated: clipped.truncated || result.truncated,
    };
  },
});

export const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read part of one text file from the workspace.',
  timeoutMs: REGISTRY_LIMITS.readTimeoutMs,
  input: z.strictObject({
    path: WorkspacePathSchema.describe('the file to read'),
    startLine: z.int().positive().optional().describe('the first line, counting from one'),
    lineCount: boundedCount.optional().describe('how many lines to read'),
  }),
  run: async (input, context) => {
    const result = await readFile(context.sandbox, {
      path: input.path,
      ...only('startLine', input.startLine),
      ...only('lineCount', input.lineCount),
    });

    const clipped = clip(result.contents);

    return {
      summary: shorten(
        `${result.path}: lines ${String(result.startLine)} to ${String(result.endLine)} of ${String(result.totalLines)}`,
      ),
      paths: [result.path],
      text: clipped.text,
      truncated: clipped.truncated || result.truncated,
    };
  },
});

export const createFileTool = defineTool({
  name: 'create_file',
  description: 'Create one new text file. It fails if the file already exists.',
  timeoutMs: REGISTRY_LIMITS.writeTimeoutMs,
  input: z.strictObject({
    path: WorkspacePathSchema.describe('the file to create'),
    contents: z.string().max(131_072).describe('what to put in it'),
  }),
  run: async (input, context) => {
    const result = await createFile(context.sandbox, input);

    return {
      summary: shorten(`created ${result.path}, ${String(result.bytes)} bytes`),
      paths: [result.path],
    };
  },
});

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description: 'Apply a unified diff to the workspace. Context lines must match exactly.',
  timeoutMs: REGISTRY_LIMITS.writeTimeoutMs,
  input: z.strictObject({
    patch: z.string().min(1).max(524_288).describe('a unified diff'),
  }),
  run: async (input, context) => {
    const result = await applyPatch(context.sandbox, input);

    return {
      summary: shorten(
        `files changed: ${String(result.files.length)}, +${String(result.addedLines)} -${String(result.removedLines)}`,
      ),
      paths: result.files.slice(0, REGISTRY_LIMITS.pathsPerRecordMax).map((file) => file.path),
    };
  },
});

export const runCommandTool = defineTool({
  name: 'run_command',
  description: 'Run one allowed command in the sandbox. There is no shell, so nothing is expanded.',
  timeoutMs: REGISTRY_LIMITS.commandTimeoutMs,
  input: z.strictObject({
    argv: argv.describe('the program and its arguments, already split'),
    timeoutMs: z.int().positive().max(REGISTRY_LIMITS.commandTimeoutMs).optional(),
  }),
  run: async (input, context) => {
    const result = await context.commands.run({
      argv: input.argv,
      signal: context.signal,
      ...only('timeoutMs', input.timeoutMs),
    });

    const clipped = clip(`${result.stdout}${result.stderr}`);

    return {
      summary: shorten(
        `${input.argv[0] ?? 'command'} exited ${String(result.exitCode ?? -1)} in ${String(result.durationMs)} ms`,
      ),
      text: clipped.text,
      truncated: clipped.truncated || result.truncated,
      ...only('outcome', outcomeFromCommand(result.outcome)),
    };
  },
});

export function checkStatusFor(outcome: string): 'passed' | 'failed' | 'errored' {
  if (outcome === 'succeeded') {
    return 'passed';
  }
  return outcome === 'failed' ? 'failed' : 'errored';
}

export function outcomeFromCommand(outcome: string): ToolOutcome | undefined {
  if (outcome === 'timed_out') {
    return 'timed_out';
  }
  return outcome === 'cancelled' ? 'cancelled' : undefined;
}

export const runChecksTool = defineTool({
  name: 'run_checks',
  description: 'Run a named check, such as the tests, and record whether it passed.',
  timeoutMs: REGISTRY_LIMITS.checkTimeoutMs,
  input: z.strictObject({
    name: z.string().min(1).max(120).describe('what to call this check'),
    kind: CheckKindSchema,
    argv,
  }),
  run: async (input, context) => {
    const result = await context.commands.run({ argv: input.argv, signal: context.signal });
    const clipped = clip(`${result.stdout}${result.stderr}`);
    const status = checkStatusFor(result.outcome);
    const detail = result.stderr === '' ? result.stdout : result.stderr;

    return {
      summary: shorten(`${input.name}: ${status}`),
      text: clipped.text,
      truncated: clipped.truncated || result.truncated,
      ...only('outcome', outcomeFromCommand(result.outcome)),
      check: CheckResultSchema.parse({
        name: input.name,
        kind: input.kind,
        status,
        summary: detail.slice(0, LIMITS.summaryMaxChars),
        durationMs: result.durationMs,
      }),
    };
  },
});

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'Show which files have changed in the workspace, without changing anything.',
  timeoutMs: REGISTRY_LIMITS.readTimeoutMs,
  input: z.strictObject({}),
  run: async (_input, context) => {
    const result = await context.commands.run({
      argv: ['git', 'status', '--porcelain'],
      signal: context.signal,
    });

    const clipped = clip(result.stdout);
    const changed = result.stdout.split('\n').filter((line) => line.trim() !== '').length;

    return {
      summary: shorten(`files changed: ${String(changed)}`),
      text: clipped.text,
      truncated: clipped.truncated || result.truncated,
      ...only('outcome', outcomeFromCommand(result.outcome)),
    };
  },
});

export const prepareCommitTool = defineTool({
  name: 'prepare_commit',
  description:
    'Package the changes so far for review. This does not push and does not open a pull request.',
  timeoutMs: REGISTRY_LIMITS.writeTimeoutMs,
  input: z.strictObject({
    summary: z.string().min(1).max(LIMITS.summaryMaxChars).describe('what these changes do'),
  }),
  run: async (input, context) => {
    const exported = await context.sandbox.exportPatch();

    return {
      summary: shorten(
        `${input.summary}: ${String(exported.files.length)} files, +${String(exported.addedLines)} -${String(exported.removedLines)}`,
      ),
      paths: exported.files.slice(0, REGISTRY_LIMITS.pathsPerRecordMax).map((file) => file.path),
    };
  },
});

export const messageUserTool = defineTool({
  name: 'message_user',
  description: 'Tell the user what you are doing. This does not pause the run.',
  timeoutMs: REGISTRY_LIMITS.instantTimeoutMs,
  input: z.strictObject({
    text: z.string().min(1).max(REGISTRY_LIMITS.messageMaxChars),
  }),
  run: async (input) => await Promise.resolve({ summary: shorten(input.text), text: input.text }),
});

export const waitForUserTool = defineTool({
  name: 'wait_for_user',
  description:
    'Stop and hand control back to the user, either to ask one question or to ask for approval.',
  timeoutMs: REGISTRY_LIMITS.instantTimeoutMs,
  input: z.strictObject({
    reason: z.enum(['clarification', 'approval']),
    question: z.string().min(1).max(REGISTRY_LIMITS.questionMaxChars),
  }),
  run: async (input) =>
    await Promise.resolve({
      summary: `waiting for ${input.reason}`,
      text: input.question,
      pause: input.reason,
    }),
});

export const BUILT_IN_TOOLS: readonly ToolDefinition[] = [
  listTreeTool,
  searchCodeTool,
  readFileTool,
  createFileTool,
  applyPatchTool,
  runCommandTool,
  runChecksTool,
  gitStatusTool,
  prepareCommitTool,
  messageUserTool,
  waitForUserTool,
];
