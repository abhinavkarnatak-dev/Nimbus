import type { SandboxConfig } from '../../src/config/load.js';
import { createLogger } from '../../src/logging/logger.js';
import {
  FakeSandboxProvider,
  SandboxError,
  buildSandboxSpec,
  withSandbox,
  type Sandbox,
} from '../../src/sandbox/index.js';

const SESSION_ID = 'ses_demodemodemodemodem';

const logger = createLogger({ level: 'info', environment: 'development' });

const sandboxConfig: SandboxConfig = {
  provider: 'fake',
  maxSeconds: 30,
  allowInternet: false,
  templateId: 'nimbus-sandbox',
};

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(22)} ${String(value)}\n`);
}

function buildProvider(): FakeSandboxProvider {
  return new FakeSandboxProvider({
    files: {
      'README.md': '# Demo\n\nA tiny repository.\n',
      'src/greet.ts': 'export function greet(name: string): string {\n  return `Hi ${name}`;\n}\n',
    },
    commands: {
      'git status --porcelain': { stdout: '' },
      'npm test': { stdout: '2 passing\n', exitCode: 0, durationMs: 3_000 },
      'npm run build': { hangs: true },
    },
    defaultCommand: { stdout: '' },
  });
}

async function showNormalWork(): Promise<void> {
  heading('1. Ordinary work, then guaranteed teardown');

  const provider = buildProvider();

  const patch = await withSandbox(
    { provider, spec: buildSandboxSpec(sandboxConfig, SESSION_ID), logger },
    async (sandbox: Sandbox) => {
      const checks = await sandbox.execute({ argv: ['npm', 'test'] });
      line('command outcome', checks.outcome);
      line('output', checks.stdout.trim());
      line('time it used', `${String(checks.durationMs)}ms`);
      line('time left', `${String(Math.round(sandbox.status().remainingMs / 1000))}s`);

      await sandbox.writeFile(
        'src/greet.ts',
        'export function greet(name: string): string {\n  return `Hello ${name}`;\n}\n',
      );
      await sandbox.writeFile('src/farewell.ts', 'export const bye = "bye";\n');

      return await sandbox.exportPatch();
    },
  );

  line('files changed', patch.files.length);
  line('lines added', patch.addedLines);
  line('lines removed', patch.removedLines);
  line('sandbox state now', provider.created[0]?.status().state);
  line('live sandboxes', provider.liveCount);

  heading('The patch that crossed the wall');
  process.stdout.write(
    patch.patch
      .split('\n')
      .map((row) => `  ${row}`)
      .join('\n'),
  );
}

async function showTimeout(): Promise<void> {
  heading('2. A command that never finishes');

  const provider = buildProvider();

  await withSandbox(
    { provider, spec: buildSandboxSpec(sandboxConfig, SESSION_ID), logger },
    async (sandbox: Sandbox) => {
      const result = await sandbox.execute({ argv: ['npm', 'run', 'build'], timeoutMs: 10_000 });
      line('command outcome', result.outcome);
      line('killed after', `${String(result.durationMs)}ms`);
      line('session time left', `${String(Math.round(sandbox.status().remainingMs / 1000))}s`);
    },
  );

  line('sandbox state now', provider.created[0]?.status().state);
}

async function showCancellation(): Promise<void> {
  heading('3. The user presses stop while a command is running');

  const controller = new AbortController();
  const provider = buildProvider();
  provider.configure({
    onCommandStarted: () => {
      controller.abort();
    },
  });

  await withSandbox(
    {
      provider,
      spec: buildSandboxSpec(sandboxConfig, SESSION_ID),
      logger,
      signal: controller.signal,
    },
    async (sandbox: Sandbox) => {
      const result = await sandbox.execute({
        argv: ['npm', 'run', 'build'],
        signal: controller.signal,
      });
      line('command outcome', result.outcome);
      line('state during the run', sandbox.status().state);
    },
  );

  line('sandbox state now', provider.created[0]?.status().state);
  line('reason', provider.created[0]?.status().terminationReason);
}

async function showCredentialRefusal(): Promise<void> {
  heading('4. Somebody tries to hand the sandbox a credential');

  const provider = buildProvider();
  const spec = buildSandboxSpec(sandboxConfig, SESSION_ID);
  const hostile = {
    ...spec,
    env: { ...spec.env, GITHUB_TOKEN: 'ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  };

  try {
    await provider.create(hostile);
    line('result', 'CREATED, which would be a serious defect');
  } catch (error) {
    line('result', 'refused');
    line('code', error instanceof SandboxError ? error.code : 'unknown');
    line('sandboxes created', provider.created.length);
  }
}

async function showTeardownFailure(): Promise<void> {
  heading('5. The work fails and the cleanup fails too');

  const provider = buildProvider();
  provider.configure({ terminateFails: new Error('provider unreachable') });

  try {
    await withSandbox(
      { provider, spec: buildSandboxSpec(sandboxConfig, SESSION_ID), logger },
      async () => {
        await Promise.resolve();
        throw new Error('the real problem');
      },
    );
  } catch (error) {
    line('error you get told', error instanceof Error ? error.message : 'unknown');
    line('sandbox state now', provider.created[0]?.status().state);
  }
}

async function main(): Promise<void> {
  await showNormalWork();
  await showTimeout();
  await showCancellation();
  await showCredentialRefusal();
  await showTeardownFailure();
  process.stdout.write('\n');
}

await main();
