import { CommandRunner } from '../commands/runner.js';
import { capturingLogger } from '../../llm/llm.fixtures.js';
import {
  FakeSandboxProvider,
  buildSandboxSpec,
  type FakeSandboxOptions,
  type Sandbox,
} from '../../sandbox/index.js';
import { ToolRegistry } from './registry.js';

export const SESSION_ID = 'ses_registryregistryreg';

export const WORKSPACE: Readonly<Record<string, string>> = {
  'README.md': '# Demo\n\nA small repository.\n',
  'src/index.ts': 'import { greet } from "./greet.js";\n\ngreet("world");\n',
  'src/greet.ts': 'export function greet(name: string): string {\n  return `Hi ${name}`;\n}\n',
  'src/auth/login.ts': 'export const login = true;\n',
  '.env': 'GITHUB_TOKEN=ghs_notarealtokenatallbutlong\n',
  'node_modules/left-pad/index.js': 'module.exports = 1;\n',
};

export interface Harness {
  registry: ToolRegistry;
  sandbox: Sandbox;
  commands: CommandRunner;
  logs: () => string;
}

export async function harness(options: FakeSandboxOptions = {}): Promise<Harness> {
  const provider = new FakeSandboxProvider({
    files: WORKSPACE,
    links: { 'notes.txt': '/etc/passwd' },
    ...options,
  });

  const sandbox = await provider.create(
    buildSandboxSpec(
      { provider: 'fake', maxSeconds: 60, allowInternet: false, templateId: 'test' },
      SESSION_ID,
    ),
  );

  const captured = capturingLogger();
  const commands = new CommandRunner(sandbox);

  return {
    registry: new ToolRegistry({
      sessionId: SESSION_ID,
      sandbox,
      commands,
      logger: captured.logger,
    }),
    sandbox,
    commands,
    logs: captured.text,
  };
}

export const VALID_INPUT: Readonly<Record<string, unknown>> = {
  list_tree: {},
  search_code: { query: 'greet' },
  read_file: { path: 'src/greet.ts' },
  create_file: { path: 'src/new.ts', contents: 'export const a = 1;\n' },
  apply_patch: { patch: 'diff --git a/x b/x\n' },
  run_command: { argv: ['git', 'status'] },
  run_checks: { name: 'tests', kind: 'test', argv: ['vitest', 'run'] },
  git_status: {},
  prepare_commit: { summary: 'made a change' },
  message_user: { text: 'looking at the login code' },
  finish_task: { text: 'The requested result is already present.' },
  wait_for_user: { reason: 'clarification', question: 'which login do you mean?' },
};
