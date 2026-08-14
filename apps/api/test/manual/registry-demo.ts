import { CommandRunner } from '../../src/agent/commands/index.js';
import {
  BUILT_IN_TOOLS,
  REGISTRY_LIMITS,
  ToolRegistry,
  defineTool,
  nameLooksForbidden,
} from '../../src/agent/registry/index.js';
import { createLogger } from '../../src/logging/logger.js';
import { FakeSandboxProvider, buildSandboxSpec, type Sandbox } from '../../src/sandbox/index.js';
import { z } from 'zod';

const SESSION_ID = 'ses_demodemodemodemodem';

const FILES: Readonly<Record<string, string>> = {
  'README.md': '# Demo\n\nA small repository.\n',
  'src/greet.ts': 'export function greet(name: string): string {\n  return `Hi ${name}`;\n}\n',
  'src/auth/login.ts': 'export const login = true;\n',
  '.env': 'GITHUB_TOKEN=ghs_notarealtokenatallbutlong\n',
};

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(38)} ${String(value)}\n`);
}

async function makeSandbox(): Promise<Sandbox> {
  const provider = new FakeSandboxProvider({
    files: FILES,
    links: { 'notes.txt': '/etc/passwd' },
    commands: {
      'git status --porcelain': { stdout: ' M src/greet.ts\n', exitCode: 0 },
      'vitest run': { stdout: '2 passed', exitCode: 0 },
    },
  });

  return await provider.create(
    buildSandboxSpec(
      { provider: 'fake', maxSeconds: 60, allowInternet: false, templateId: 'demo' },
      SESSION_ID,
    ),
  );
}

async function main(): Promise<void> {
  const logger = createLogger({ level: 'warn', environment: 'development' });
  const sandbox = await makeSandbox();
  const registry = new ToolRegistry({
    sessionId: SESSION_ID,
    sandbox,
    commands: new CommandRunner(sandbox),
    logger,
  });

  heading('What a model is offered');
  for (const tool of registry.describe()) {
    line(tool.name, tool.description.slice(0, 60));
  }

  heading('What it is never offered');
  for (const name of ['push_branch', 'open_pull_request', 'get_token', 'http_get', 'read_secret']) {
    line(name, `refused: looks like ${String(nameLooksForbidden(name))}`);
  }
  line(
    'semantic_search',
    registry.has('semantic_search') ? 'offered' : 'not built, so not offered',
  );

  heading('Every tool has a closed schema');
  for (const tool of registry.describe()) {
    line(tool.name, `additionalProperties: ${String(tool.parameters['additionalProperties'])}`);
  }

  heading('An extra field is refused, not ignored');
  for (const [label, input] of [
    ['exactly what it asked for', { path: 'src/greet.ts' }],
    ['one extra field', { path: 'src/greet.ts', force: true }],
    ['a missing field', { startLine: 1 }],
    ['the wrong type', { path: 42 }],
  ] as const) {
    const result = await registry.invoke({ toolCallId: label, tool: 'read_file', input });
    line(label, `${result.outcome}${result.errorCode === null ? '' : `, ${result.errorCode}`}`);
  }

  heading('The rules from feature 017 still apply');
  for (const [label, path] of [
    ['a link out of the workspace', 'notes.txt'],
    ['an environment file', '.env'],
    ['a file that is not there', 'nope.ts'],
  ] as const) {
    const result = await registry.invoke({
      toolCallId: label,
      tool: 'read_file',
      input: { path },
    });
    line(label, `${result.outcome}, ${String(result.errorCode)}`);
  }

  heading('Commands, checks and status');
  const check = await registry.invoke({
    toolCallId: 'check',
    tool: 'run_checks',
    input: { name: 'tests', kind: 'test', argv: ['vitest', 'run'] },
  });
  line('run_checks', `${result(check.outcome)}, check ${String(check.output?.check?.status)}`);

  const status = await registry.invoke({ toolCallId: 'status', tool: 'git_status', input: {} });
  line('git_status', `${result(status.outcome)}, ${String(status.output?.summary)}`);

  const denied = await registry.invoke({
    toolCallId: 'denied',
    tool: 'run_command',
    input: { argv: ['curl', 'https://example.com'] },
  });
  line('a command not on the allowlist', `${denied.outcome}, ${String(denied.errorCode)}`);

  heading('Stopping for the user');
  const pause = await registry.invoke({
    toolCallId: 'pause',
    tool: 'wait_for_user',
    input: { reason: 'approval', question: 'may I change the workflow file?' },
  });
  line('wait_for_user', `${pause.outcome}, pause: ${String(pause.output?.pause)}`);

  heading('Cancelling');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await registry.invoke({
    toolCallId: 'cancel',
    tool: 'read_file',
    input: { path: 'src/greet.ts' },
    signal: controller.signal,
  });
  line('already cancelled', `${cancelled.outcome}, nothing was read`);

  heading('Every call leaves a record, whatever happened');
  const records = [check, status, denied, pause, cancelled];
  for (const one of records) {
    line(
      one.invocation.toolCallId,
      `${one.outcome}, summary ${String(one.invocation.summary.length)} chars`,
    );
  }
  line('raw arguments in a record', 'none, by shape');
  line('summary cap', REGISTRY_LIMITS.summaryMaxChars);
  line('tools registered', BUILT_IN_TOOLS.length);

  heading('A forbidden tool cannot be added later');
  try {
    registry.register(
      defineTool({
        name: 'push_branch' as 'message_user',
        description: 'push the branch to GitHub',
        timeoutMs: 1_000,
        input: z.strictObject({}),
        run: async () => await Promise.resolve({ summary: 'pushed' }),
      }),
    );
    line('registering push_branch', 'it was accepted, which it should not have been');
  } catch (error) {
    line('registering push_branch', `refused: ${(error as { code: string }).code}`);
  }

  await sandbox.terminate('completed');
}

function result(outcome: string): string {
  return outcome;
}

await main();
