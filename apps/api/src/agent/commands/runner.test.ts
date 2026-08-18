import { describe, expect, it } from 'vitest';

import { REDACTED } from '../../logging/redact.js';
import { FakeSandboxProvider, SANDBOX_LIMITS, type Sandbox } from '../../sandbox/index.js';
import { testSpec } from '../../sandbox/sandbox.fixtures.js';
import { TRUNCATION_NOTICE } from './output.js';
import {
  COMMAND_LIMITS,
  CommandRefused,
  CommandRunner,
  describeRunForLog,
  isolatedCheckArgv,
  isCheckGeneratedPath,
  type RunCommandInput,
} from './runner.js';

const ESC = String.fromCharCode(27);

async function sandboxWith(
  options: ConstructorParameters<typeof FakeSandboxProvider>[0] = {},
): Promise<Sandbox> {
  return await new FakeSandboxProvider(options).create(testSpec());
}

async function refusalOf(runner: CommandRunner, input: RunCommandInput): Promise<string> {
  try {
    await runner.run(input);
  } catch (error) {
    return error instanceof CommandRefused ? error.code : 'NOT_A_REFUSAL';
  }
  return 'NO_REFUSAL';
}

describe('running an allowed command', () => {
  it('runs it and hands back cleaned output', async () => {
    const sandbox = await sandboxWith({
      commands: { 'git status': { stdout: `${ESC}[32mclean${ESC}[0m\n` } },
    });
    const result = await new CommandRunner(sandbox).run({ argv: ['git', 'status'] });

    expect(result.outcome).toBe('succeeded');
    expect(result.stdout).toBe('clean\n');
    expect(result.category).toBe('read_only');
    expect(result.decision).toBe('allowed');
  });

  it('reports a failing command as a result rather than an error', async () => {
    const sandbox = await sandboxWith({
      commands: { 'npm test': { stderr: '1 failing\n', exitCode: 1 } },
    });
    const result = await new CommandRunner(sandbox).run({ argv: ['npm', 'test'] });

    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('1 failing\n');
  });

  it('hides a secret the command printed', async () => {
    const sandbox = await sandboxWith({
      defaultCommand: { stdout: 'token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa used\n' },
    });
    const result = await new CommandRunner(sandbox).run({ argv: ['git', 'status'] });

    expect(result.stdout).toContain(REDACTED);
    expect(result.stdout).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.redacted).toBe(true);
  });
});

describe('check workspace isolation', () => {
  it('sends Java compiler output outside the repository and removes a defensive generated artifact', async () => {
    const sandbox = await sandboxWith({
      commands: {
        'javac -d /tmp/nimbus-javac-output Main.java': {
          writes: { 'Main.class': 'compiled bytecode' },
        },
      },
    });
    await sandbox.writeFile('Main.java', 'class Main {}\n');

    const result = await new CommandRunner(sandbox).run({
      argv: ['javac', 'Main.java'],
      check: true,
    });
    const patch = await sandbox.exportPatch();

    expect(result.generatedPaths).toEqual(['Main.class']);
    expect(patch.files.map((file) => file.path)).toEqual(['Main.java']);
  });

  it('reports a new non-generated file rather than silently deleting it', async () => {
    const sandbox = await sandboxWith({
      commands: { 'pnpm test': { writes: { 'changed-by-test.txt': 'unexpected\n' } } },
    });

    const result = await new CommandRunner(sandbox).run({ argv: ['pnpm', 'test'], check: true });

    expect(result.generatedPaths).toEqual([]);
    expect(result.unexpectedPaths).toEqual(['changed-by-test.txt']);
    expect(await sandbox.readFile('changed-by-test.txt')).toBe('unexpected\n');
  });

  it('normalizes common compiler checks so they do not create repository output', () => {
    expect(isolatedCheckArgv(['javac', 'Main.java'])).toEqual([
      'javac',
      '-d',
      '/tmp/nimbus-javac-output',
      'Main.java',
    ]);
    expect(isolatedCheckArgv(['python', '-m', 'py_compile', 'hello.py'])).toEqual([
      'python',
      '-B',
      '-m',
      'py_compile',
      'hello.py',
    ]);
    expect(isolatedCheckArgv(['g++', 'hello.cpp'])).toEqual(['g++', '-fsyntax-only', 'hello.cpp']);
  });

  it('recognizes only known check products as generated artifacts', () => {
    expect(isCheckGeneratedPath('Main.class')).toBe(true);
    expect(isCheckGeneratedPath('__pycache__/hello.cpython-312.pyc')).toBe(true);
    expect(isCheckGeneratedPath('src/hello.py')).toBe(false);
    expect(isCheckGeneratedPath('assets/logo.png')).toBe(true);
  });
});

describe('commands that never run', () => {
  it('refuses a denied command before touching the sandbox', async () => {
    const provider = new FakeSandboxProvider();
    const sandbox = await provider.create(testSpec());
    const runner = new CommandRunner(sandbox);

    expect(await refusalOf(runner, { argv: ['curl', 'https://evil.com'] })).toBe('COMMAND_DENIED');
    expect(sandbox.status().commandsRun).toBe(0);
    expect(runner.commandsUsed).toBe(0);
  });

  it('refuses an install that needs asking, and does not spend the budget', async () => {
    const sandbox = await sandboxWith();
    const runner = new CommandRunner(sandbox);

    expect(await refusalOf(runner, { argv: ['npm', 'install', 'left-pad'] })).toBe(
      'COMMAND_APPROVAL_REQUIRED',
    );
    expect(runner.commandsUsed).toBe(0);
  });

  it('carries the classification on the refusal so a caller can explain it', async () => {
    const runner = new CommandRunner(await sandboxWith());

    try {
      await runner.run({ argv: ['npm', 'ci'] });
      expect.unreachable('should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandRefused);
      expect((error as CommandRefused).classification.reason).toContain('package scripts');
    }
  });

  it('allows the locked install that refuses package scripts', async () => {
    const sandbox = await sandboxWith({ defaultCommand: { stdout: 'added 40 packages\n' } });
    const result = await new CommandRunner(sandbox).run({
      argv: ['npm', 'ci', '--ignore-scripts'],
    });

    expect(result.category).toBe('dependency_install');
    expect(result.outcome).toBe('succeeded');
  });
});

describe('the session command budget', () => {
  it('stops once the session has run its share', async () => {
    const sandbox = await sandboxWith();
    const runner = new CommandRunner(sandbox, 2);

    await runner.run({ argv: ['git', 'status'] });
    await runner.run({ argv: ['git', 'status'] });

    expect(runner.commandsLeft).toBe(0);
    expect(await refusalOf(runner, { argv: ['git', 'status'] })).toBe('COMMAND_BUDGET_EXHAUSTED');
  });

  it('counts down as it goes', async () => {
    const runner = new CommandRunner(await sandboxWith(), 3);

    expect(runner.commandsLeft).toBe(3);
    await runner.run({ argv: ['git', 'status'] });
    expect(runner.commandsLeft).toBe(2);
  });

  it('has a default budget rather than none', () => {
    expect(COMMAND_LIMITS.commandsPerSession).toBeGreaterThan(0);
    expect(new CommandRunner({} as Sandbox).commandsLeft).toBe(COMMAND_LIMITS.commandsPerSession);
  });
});

describe('time and cancellation come from the sandbox', () => {
  it('reports a command killed for running too long', async () => {
    const sandbox = await sandboxWith({ commands: { 'npm test': { hangs: true } } });
    const result = await new CommandRunner(sandbox).run({
      argv: ['npm', 'test'],
      timeoutMs: 5_000,
    });

    expect(result.outcome).toBe('timed_out');
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBe(5_000);
  });

  it('stops a command in flight and the sandbox with it', async () => {
    const controller = new AbortController();
    const provider = new FakeSandboxProvider({
      commands: { 'npm test': { hangs: true } },
      onCommandStarted: () => {
        controller.abort();
      },
    });
    const sandbox = await provider.create(testSpec());

    const result = await new CommandRunner(sandbox).run({
      argv: ['npm', 'test'],
      signal: controller.signal,
    });

    expect(result.outcome).toBe('cancelled');
    expect(sandbox.status().state).toBe('terminated');
  });
});

describe('output that tries to exhaust us', () => {
  it('truncates a flood and says it did, keeping both ends', async () => {
    const flood = `HEAD${'x'.repeat(COMMAND_LIMITS.outputMaxChars * 2)}TAIL`;

    expect(flood.length).toBeLessThan(SANDBOX_LIMITS.outputMaxBytes);

    const sandbox = await sandboxWith({ defaultCommand: { stdout: flood } });
    const result = await new CommandRunner(sandbox).run({ argv: ['git', 'status'] });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(COMMAND_LIMITS.outputMaxChars);
    expect(result.stdout).toContain(TRUNCATION_NOTICE);
    expect(result.stdout.startsWith('HEAD')).toBe(true);
    expect(result.stdout.endsWith('TAIL')).toBe(true);
  });

  it('runs under the sandbox cap, so the smart trim is the one that happens', () => {
    expect(COMMAND_LIMITS.outputMaxChars).toBeLessThan(SANDBOX_LIMITS.outputMaxBytes);
  });

  it('loses the end when even the sandbox cap is passed, and still says it was cut', async () => {
    const flood = `HEAD${'x'.repeat(SANDBOX_LIMITS.outputMaxBytes * 2)}TAIL`;
    const sandbox = await sandboxWith({ defaultCommand: { stdout: flood } });
    const result = await new CommandRunner(sandbox).run({ argv: ['git', 'status'] });

    expect(result.truncated).toBe(true);
    expect(result.stdout).not.toContain('TAIL');
  });

  it('shares one cap between the two streams', async () => {
    const half = 'x'.repeat(COMMAND_LIMITS.outputMaxChars);
    const sandbox = await sandboxWith({
      defaultCommand: { stdout: half, stderr: 'important error\n' },
    });
    const result = await new CommandRunner(sandbox).run({ argv: ['git', 'status'] });

    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(
      COMMAND_LIMITS.outputMaxChars,
    );
  });

  it('strips a hostile escape sequence a test suite printed', async () => {
    const sandbox = await sandboxWith({
      defaultCommand: { stdout: `${ESC}]0;owned${String.fromCharCode(7)}all tests passed\n` },
    });
    const result = await new CommandRunner(sandbox).run({ argv: ['npm', 'test'] });

    expect(result.stdout).toBe('all tests passed\n');
    expect(result.stdout).not.toContain(ESC);
  });
});

describe('describeRunForLog', () => {
  it('reports the shape of the run without the arguments', async () => {
    const sandbox = await sandboxWith({ defaultCommand: { stdout: 'ok' } });
    const runner = new CommandRunner(sandbox);
    const argv = ['git', 'log', '--grep', 'something from the repository'];
    const result = await runner.run({ argv });

    const described = describeRunForLog(runner.classify(argv), result);

    expect(described).toMatchObject({ program: 'git', subcommand: 'log', category: 'read_only' });
    expect(JSON.stringify(described)).not.toContain('something from the repository');
  });
});
