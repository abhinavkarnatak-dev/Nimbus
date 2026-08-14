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
  description:
    'List the files and folders in the workspace, or under one folder. Use this first to learn how the repository is laid out. It does not read file contents, so use read_file for that, or search_code to find text when you do not know which file to open. Dependency folders, build output, binaries and credential files are never listed. Returns each path with its kind and size.',
  timeoutMs: REGISTRY_LIMITS.readTimeoutMs,
  input: z.strictObject({
    path: WorkspacePathSchema.optional().describe(
      'a folder to list, such as src/auth. Omit it to list the whole repository',
    ),
    maxEntries: boundedCount
      .optional()
      .describe('stop after this many entries. Omit it unless a folder is known to be very large'),
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
  description:
    'Find every line in the workspace containing a piece of literal text. Use this to locate where something is defined or used when you do not yet know which file holds it. The query is plain text, not a regular expression, so search for an exact identifier such as redirectAfterLogin rather than a pattern. Returns the path, line number and matching line; follow up with read_file to see the code around a match.',
  timeoutMs: REGISTRY_LIMITS.searchTimeoutMs,
  input: z.strictObject({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe('the exact text to look for, such as a function or variable name'),
    caseSensitive: z.boolean().optional().describe('match capitals exactly. Defaults to false'),
    pathPrefix: WorkspacePathSchema.optional().describe(
      'only search under this folder, such as src/auth, to cut out unrelated matches',
    ),
    maxMatches: boundedCount.optional().describe('stop after this many matches'),
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
  description:
    'Read a range of lines from one text file. Use this once list_tree or search_code has told you which file matters, and read a window around the interesting lines rather than the whole file. Always read a file before patching it, because apply_patch requires the context lines to match exactly. Returns the lines you asked for and how many lines the file has in total.',
  timeoutMs: REGISTRY_LIMITS.readTimeoutMs,
  input: z.strictObject({
    path: WorkspacePathSchema.describe('the file to read, such as src/auth/login.ts'),
    startLine: z
      .int()
      .positive()
      .optional()
      .describe('the first line to read, counting from one. Omit it to start at the top'),
    lineCount: boundedCount
      .optional()
      .describe('how many lines to read. Omit it to read as much as the limit allows'),
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
  description:
    'Create one new text file with the contents you give. Use this only for a file that does not exist yet; it fails rather than overwriting if it does. To change a file that already exists use apply_patch. Creating a protected file, such as anything under .github, needs a person to approve it first.',
  timeoutMs: REGISTRY_LIMITS.writeTimeoutMs,
  input: z.strictObject({
    path: WorkspacePathSchema.describe('where the new file goes, such as src/auth/redirect.ts'),
    contents: z
      .string()
      .max(131_072)
      .describe('the complete text of the file, exactly as it should be written'),
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
  description:
    'Change one or more existing files by applying a unified diff. Read each file first, because every context line in the diff must match the file exactly or nothing is applied. Use this for all edits to existing files; use create_file for a file that does not exist yet. Deleting or renaming a file, touching a protected path, or a very large diff needs a person to approve it first.',
  timeoutMs: REGISTRY_LIMITS.writeTimeoutMs,
  input: z.strictObject({
    patch: z
      .string()
      .min(1)
      .max(524_288)
      .describe(
        'a unified diff with --- and +++ headers and @@ hunks, using paths relative to the repository root',
      ),
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
  description:
    'Run one command from the allowed list inside the sandbox, given as a list of words rather than a shell line. There is no shell, so pipes, redirects, wildcards, variables and chained commands are not expanded and must not be used. Use this for one off inspection such as reading a version. To run the tests, linter, type checker or build, use run_checks instead, because only that records a result for the pull request. Returns the output and the exit code.',
  timeoutMs: REGISTRY_LIMITS.commandTimeoutMs,
  input: z.strictObject({
    argv: argv.describe(
      'the program then each argument as its own item, for example ["git", "log", "-n", "5"]',
    ),
    timeoutMs: z
      .int()
      .positive()
      .max(REGISTRY_LIMITS.commandTimeoutMs)
      .optional()
      .describe('give up after this many milliseconds. Omit it to use the default'),
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
  description:
    'Run the project tests, linter, type checker or build, and record whether it passed. Use this rather than run_command whenever the result should be reported to the user and shown in the pull request. Run it after making changes and before prepare_commit. A non zero exit is a failing check, not a broken tool, so read the output and fix the cause. Returns the output and a recorded pass, fail or error.',
  timeoutMs: REGISTRY_LIMITS.checkTimeoutMs,
  input: z.strictObject({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe('a short name the user will see, such as unit tests or lint'),
    kind: CheckKindSchema.describe('which sort of check this is'),
    argv: argv.describe(
      'the command as a list of words, for example ["pnpm", "test"], taken from the repository scripts',
    ),
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
  description:
    'List which files you have added, changed or deleted in the workspace so far. It changes nothing and takes no arguments. Use it to confirm your edits landed where you meant, and to check nothing unintended was touched before calling prepare_commit. Returns one line per changed file.',
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
    'Package the changes made so far for human review, with a short summary of what they do. This does not push, does not open a pull request and does not merge; Nimbus handles that separately after a person has looked. Call it once, at the end, after git_status shows what you expect and run_checks has been run. Returns the files included and how many lines changed.',
  timeoutMs: REGISTRY_LIMITS.writeTimeoutMs,
  input: z
    .strictObject({
      summary: z
        .string()
        .min(1)
        .max(LIMITS.summaryMaxChars)
        .describe(
          'one or two plain sentences saying what changed and why, written for the person reviewing it',
        ),
    })
    .describe('what to tell the reviewer about these changes'),
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
  description:
    'Send the user a short progress note. The run carries straight on and nothing pauses, so use it to say what you have found or what you are about to do. It is not a way to ask anything; if you need an answer or permission, use wait_for_user instead.',
  timeoutMs: REGISTRY_LIMITS.instantTimeoutMs,
  input: z.strictObject({
    text: z
      .string()
      .min(1)
      .max(REGISTRY_LIMITS.messageMaxChars)
      .describe('one or two sentences in plain language, with no internal reasoning'),
  }),
  run: async (input) => await Promise.resolve({ summary: shorten(input.text), text: input.text }),
});

export const waitForUserTool = defineTool({
  name: 'wait_for_user',
  description:
    'Stop the run and hand control back to the user. Use reason clarification to ask one specific question when the task is genuinely ambiguous and no amount of reading the code would settle it, and reason approval to ask permission for an action that policy will not allow on its own. The run stays stopped until they reply, so ask only when you truly cannot continue, and ask once rather than in pieces.',
  timeoutMs: REGISTRY_LIMITS.instantTimeoutMs,
  input: z.strictObject({
    reason: z
      .enum(['clarification', 'approval'])
      .describe('clarification to ask a question, approval to ask permission for an action'),
    question: z
      .string()
      .min(1)
      .max(REGISTRY_LIMITS.questionMaxChars)
      .describe(
        'one specific question, naming the exact files or choices involved, answerable in a sentence',
      ),
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
