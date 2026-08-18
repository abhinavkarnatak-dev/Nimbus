import { TOOL_NAMES, ToolInvocationSchema } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { defineTool, describeForModel, nameLooksForbidden } from './definition.js';
import { REGISTRY_LIMITS } from './limits.js';
import { SESSION_ID, VALID_INPUT, harness } from './registry.fixtures.js';
import { BUILT_IN_TOOLS } from './tools.js';
import { z } from 'zod';

describe('the tools that are offered', () => {
  it('offers only names the contract knows', async () => {
    const { registry } = await harness();

    for (const name of registry.names()) {
      expect(TOOL_NAMES).toContain(name);
    }
  });

  it('offers twelve tools, because semantic search is not built', async () => {
    const { registry } = await harness();

    expect(registry.names()).toHaveLength(12);
    expect(registry.has('semantic_search')).toBe(false);
  });

  it.each([
    ['push', 'push_branch'],
    ['a pull request', 'open_pull_request'],
    ['a merge', 'merge_branch'],
    ['a token', 'get_token'],
    ['a secret', 'read_secret'],
    ['the network', 'http_get'],
    ['a download', 'download_file'],
  ])('never offers %s', (_label, name) => {
    expect(nameLooksForbidden(name)).not.toBeNull();
  });

  it('lets none of the real tools look forbidden', () => {
    for (const tool of BUILT_IN_TOOLS) {
      expect(nameLooksForbidden(tool.name)).toBeNull();
    }
  });

  it('refuses to register a forbidden tool', async () => {
    const { registry } = await harness();
    const hostile = defineTool({
      name: 'push_branch' as 'message_user',
      description: 'push the branch',
      timeoutMs: 1_000,
      input: z.strictObject({}),
      run: async () => await Promise.resolve({ summary: 'pushed' }),
    });

    expect(() => {
      registry.register(hostile);
    }).toThrow(expect.objectContaining({ code: 'TOOL_FORBIDDEN' }) as Error);
  });

  it('refuses to register the same tool twice', async () => {
    const { registry } = await harness();

    expect(() => {
      registry.register(BUILT_IN_TOOLS[0] as never);
    }).toThrow(expect.objectContaining({ code: 'TOOL_FORBIDDEN' }) as Error);
  });
});

describe('what every tool must have', () => {
  it.each(BUILT_IN_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s has a description long enough to choose by',
    (_name, tool) => {
      expect(tool.description.length).toBeGreaterThanOrEqual(REGISTRY_LIMITS.descriptionMinChars);
      expect(tool.description.length).toBeLessThanOrEqual(REGISTRY_LIMITS.descriptionMaxChars);
    },
  );

  it.each(BUILT_IN_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s explains every argument it takes',
    (_name, tool) => {
      const properties = (tool.jsonSchema()['properties'] ?? {}) as Record<
        string,
        { description?: string }
      >;

      for (const [field, shape] of Object.entries(properties)) {
        expect(shape.description, `${tool.name}.${field} has no description`).toBeDefined();
        expect((shape.description ?? '').length).toBeGreaterThan(10);
      }
    },
  );

  it.each([
    ['list_tree', 'read_file'],
    ['search_code', 'read_file'],
    ['create_file', 'apply_patch'],
    ['apply_patch', 'create_file'],
    ['run_command', 'run_checks'],
    ['run_checks', 'run_command'],
    ['message_user', 'wait_for_user'],
    ['finish_task', 'wait_for_user'],
  ])('%s names %s, so a model can tell them apart', (name, sibling) => {
    const tool = BUILT_IN_TOOLS.find((one) => one.name === name);
    expect(tool?.description).toContain(sibling);
  });

  it('warns that preparing a commit does not push', () => {
    const tool = BUILT_IN_TOOLS.find((one) => one.name === 'prepare_commit');

    expect(tool?.description).toContain('does not push');
    expect(tool?.description).toContain('does not open a pull request');
  });

  it.each(BUILT_IN_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s has a timeout of its own',
    (_name, tool) => {
      expect(tool.timeoutMs).toBeGreaterThan(0);
      expect(tool.timeoutMs).toBeLessThanOrEqual(REGISTRY_LIMITS.checkTimeoutMs);
    },
  );

  it.each(BUILT_IN_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s refuses a field nobody asked for',
    (_name, tool) => {
      const good = VALID_INPUT[tool.name] as Record<string, unknown>;
      const parsed = tool.parse({ ...good, somethingExtra: true });

      expect(parsed.ok).toBe(false);
    },
  );

  it.each(BUILT_IN_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s accepts what it was designed for',
    (_name, tool) => {
      expect(tool.parse(VALID_INPUT[tool.name]).ok).toBe(true);
    },
  );

  it.each(BUILT_IN_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s refuses arguments that are not an object at all',
    (_name, tool) => {
      expect(tool.parse('just a string').ok).toBe(false);
      expect(tool.parse(null).ok).toBe(false);
      expect(tool.parse([1, 2]).ok).toBe(false);
    },
  );

  it.each(BUILT_IN_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s describes itself to a model with a closed schema',
    (_name, tool) => {
      const described = describeForModel(tool);

      expect(described.name).toBe(tool.name);
      expect(described.parameters['additionalProperties']).toBe(false);
      expect(described.parameters['type']).toBe('object');
    },
  );
});

describe('describing the tools to a model', () => {
  it('gives exactly the registered names and nothing else', async () => {
    const { registry } = await harness();
    const described = registry.describe();

    expect(described.map((one) => one.name)).toEqual(registry.names());
  });

  it('never offers a tool that is not registered', async () => {
    const { registry } = await harness();
    const offered = registry.describe().map((one) => one.name);

    expect(offered).not.toContain('semantic_search');
    expect(offered.every((name) => nameLooksForbidden(name) === null)).toBe(true);
  });

  it('tells the model plainly that preparing a commit does not push', async () => {
    const { registry } = await harness();
    const prepare = registry.describe().find((one) => one.name === 'prepare_commit');

    expect(prepare?.description).toContain('does not push');
  });
});

describe('invoking a tool', () => {
  it('reads a file and reports what it read', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_1',
      tool: 'read_file',
      input: { path: 'src/greet.ts' },
    });

    expect(result.outcome).toBe('succeeded');
    expect(result.output?.text).toContain('export function greet');
    expect(result.invocation.paths).toEqual(['src/greet.ts']);
  });

  it('refuses a tool that does not exist, without crashing', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_2',
      tool: 'delete_everything',
      input: {},
    });

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('TOOL_UNKNOWN');
    expect(result.output).toBeNull();
  });

  it('refuses semantic search the same clean way', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_3',
      tool: 'semantic_search',
      input: { query: 'login' },
    });

    expect(result.errorCode).toBe('TOOL_UNKNOWN');
  });

  it('refuses arguments the schema does not accept', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_4',
      tool: 'read_file',
      input: { path: 'src/greet.ts', force: true },
    });

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('TOOL_INPUT_INVALID');
  });

  it('names the fields that were wrong', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_5',
      tool: 'read_file',
      input: { startLine: 1 },
    });

    expect(result.message).toContain('not usable');
    expect(result.errorCode).toBe('TOOL_INPUT_INVALID');
  });

  it('still refuses a path that escapes the workspace, because 017 does', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_6',
      tool: 'read_file',
      input: { path: 'notes.txt' },
    });

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('PATH_OUTSIDE_WORKSPACE');
  });

  it('still refuses an ignored path', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_7',
      tool: 'read_file',
      input: { path: '.env' },
    });

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('PATH_IGNORED');
  });

  it('records a denied command as denied rather than failed', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_8',
      tool: 'run_command',
      input: { argv: ['rm', '-rf', '/'] },
    });

    expect(result.outcome).toBe('denied');
  });

  it('caps output that is larger than the cap', async () => {
    const { registry } = await harness({
      files: { 'big.txt': 'x'.repeat(REGISTRY_LIMITS.outputMaxChars * 2) },
    });

    const result = await registry.invoke({
      toolCallId: 'call_9',
      tool: 'read_file',
      input: { path: 'big.txt' },
    });

    expect(result.output?.text?.length ?? 0).toBeLessThanOrEqual(REGISTRY_LIMITS.outputMaxChars);
    expect(result.output?.truncated).toBe(true);
  });

  it('reports a pause when the agent wants the user', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_10',
      tool: 'wait_for_user',
      input: { reason: 'approval', question: 'may I change the workflow file?' },
    });

    expect(result.outcome).toBe('succeeded');
    expect(result.output?.pause).toBe('approval');
  });

  it('records a check result that a pull request body could use', async () => {
    const { registry } = await harness({
      commands: { 'vitest run': { stdout: 'all good', exitCode: 0 } },
    });

    const result = await registry.invoke({
      toolCallId: 'call_11',
      tool: 'run_checks',
      input: { name: 'tests', kind: 'test', argv: ['vitest', 'run'] },
    });

    expect(result.output?.check?.status).toBe('passed');
    expect(result.output?.check?.name).toBe('tests');
  });

  it('records a failing check as failed rather than errored', async () => {
    const { registry } = await harness({
      commands: { 'vitest run': { stdout: '1 failed', exitCode: 1 } },
    });

    const result = await registry.invoke({
      toolCallId: 'call_12',
      tool: 'run_checks',
      input: { name: 'tests', kind: 'test', argv: ['vitest', 'run'] },
    });

    expect(result.output?.check?.status).toBe('failed');
    expect(result.outcome).toBe('succeeded');
  });
});

describe('cancellation and timeouts', () => {
  it('refuses work that was cancelled before it began', async () => {
    const { registry } = await harness();
    const controller = new AbortController();
    controller.abort();

    const result = await registry.invoke({
      toolCallId: 'call_13',
      tool: 'read_file',
      input: { path: 'src/greet.ts' },
      signal: controller.signal,
    });

    expect(result.outcome).toBe('cancelled');
    expect(result.errorCode).toBe('TOOL_CANCELLED');
    expect(result.output).toBeNull();
  });

  it('carries the cancellation all the way down to the sandbox', async () => {
    const controller = new AbortController();
    const { registry, commands } = await harness({
      commands: { 'vitest run': { hangs: true } },
      onCommandStarted: () => {
        controller.abort();
      },
    });

    expect(commands).toBeDefined();

    const result = await registry.invoke({
      toolCallId: 'call_13b',
      tool: 'run_command',
      input: { argv: ['vitest', 'run'] },
      signal: controller.signal,
    });

    expect(result.outcome).toBe('cancelled');
  });

  it('reports a command that ran out of time as timed out, not failed', async () => {
    const { registry } = await harness({ commands: { 'vitest run': { hangs: true } } });

    const result = await registry.invoke({
      toolCallId: 'call_13c',
      tool: 'run_command',
      input: { argv: ['vitest', 'run'] },
    });

    expect(result.outcome).toBe('timed_out');
  });

  it('treats a non zero exit as a finished tool, not a broken one', async () => {
    const { registry } = await harness({
      commands: { 'vitest run': { stdout: '1 failed', exitCode: 1 } },
    });

    const result = await registry.invoke({
      toolCallId: 'call_13d',
      tool: 'run_command',
      input: { argv: ['vitest', 'run'] },
    });

    expect(result.outcome).toBe('succeeded');
    expect(result.output?.text).toContain('1 failed');
  });

  it('records an audit entry even when it was cancelled', async () => {
    const { registry } = await harness();
    const controller = new AbortController();
    controller.abort();

    const result = await registry.invoke({
      toolCallId: 'call_14',
      tool: 'run_command',
      input: { argv: ['vitest', 'run'] },
      signal: controller.signal,
    });

    expect(ToolInvocationSchema.safeParse(result.invocation).success).toBe(true);
    expect(result.invocation.toolCallId).toBe('call_14');
  });
});

describe('the audit record', () => {
  it('is produced for every outcome, including the failures', async () => {
    const { registry } = await harness();

    for (const [id, tool, input] of [
      ['a', 'read_file', { path: 'src/greet.ts' }],
      ['b', 'read_file', { path: 'nope.ts' }],
      ['c', 'nonsense_tool', {}],
      ['d', 'read_file', { wrong: 1 }],
    ] as const) {
      const result = await registry.invoke({ toolCallId: id, tool, input });

      expect(ToolInvocationSchema.safeParse(result.invocation).success).toBe(true);
      expect(result.invocation.toolCallId).toBe(id);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('holds no raw arguments and no raw output', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_15',
      tool: 'message_user',
      input: { text: 'the elephant walked into the compiler at midnight' },
    });

    const record = JSON.stringify(result.invocation);
    expect(record).not.toContain('input');
    expect(record.length).toBeLessThan(1_000);
  });

  it('never lets a summary grow past its cap', async () => {
    const { registry } = await harness();

    const result = await registry.invoke({
      toolCallId: 'call_16',
      tool: 'message_user',
      input: { text: 'y'.repeat(1_500) },
    });

    expect(result.invocation.summary.length).toBeLessThanOrEqual(REGISTRY_LIMITS.summaryMaxChars);
  });

  it('never lists more paths than it is allowed', async () => {
    const files: Record<string, string> = {};

    for (let index = 0; index < 60; index += 1) {
      files[`src/f${String(index)}.ts`] = 'export const a = 1;\n';
    }

    const { registry } = await harness({ files });
    const result = await registry.invoke({ toolCallId: 'call_17', tool: 'list_tree', input: {} });

    expect(result.invocation.paths.length).toBeLessThanOrEqual(REGISTRY_LIMITS.pathsPerRecordMax);
  });
});

describe('what reaches the logs', () => {
  it('records the tool and the outcome but not the arguments', async () => {
    const { registry, logs } = await harness();

    await registry.invoke({
      toolCallId: 'call_18',
      tool: 'message_user',
      input: { text: 'the elephant walked into the compiler' },
    });

    expect(logs()).toContain('message_user');
    expect(logs()).toContain('succeeded');
    expect(logs()).not.toContain('elephant');
  });

  it('names the session so one run can be found', async () => {
    const { registry, logs } = await harness();

    await registry.invoke({ toolCallId: 'call_19', tool: 'git_status', input: {} });
    expect(logs()).toContain(SESSION_ID);
  });
});

describe('the workspace status', () => {
  it('reports the patch held by the sandbox rather than relying on a shell implementation', async () => {
    const { registry, sandbox } = await harness();

    await sandbox.writeFile('src/new.ts', 'export const answer = 42;\n');
    const result = await registry.invoke({ toolCallId: 'call_20', tool: 'git_status', input: {} });

    expect(result.output?.summary).toBe('files changed: 1');
    expect(result.output?.text).toContain('?? src/new.ts');
    expect(result.output?.paths).toEqual(['src/new.ts']);
  });
});
