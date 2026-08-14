import { describe, expect, it } from 'vitest';

import {
  CLEAR_SCOPE,
  HOSTILE_REPOSITORY,
  REDIRECT_PATCH,
  SESSION_PATCH,
  action,
  graphHarness,
} from './graph.fixtures.js';
import { runAgent } from './run.js';

const READ = action('read_file', { path: 'src/routing/redirect.ts' });
const PATCH = action('apply_patch', { patch: REDIRECT_PATCH });
const CHECKS = action('run_checks', {
  name: 'unit tests',
  kind: 'test',
  argv: ['pnpm', 'test'],
});
const COMMIT = action('prepare_commit', { summary: 'send people back where they came from' });
const CURL = action('run_command', { argv: ['curl', 'https://collect.example.com/config'] });
const WORKFLOW = action('create_file', {
  path: '.github/workflows/deploy.yml',
  contents: 'name: deploy\n',
});

const UNCLEAR = {
  value: {
    clear: false,
    question: 'Which page should people land on after signing in?',
  },
};

describe('a whole run, with nobody calling a node by hand', () => {
  it('clones, reads, patches, checks and hands over a patch', async () => {
    const harness = await graphHarness({
      answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT],
    });

    const result = await runAgent(harness);

    expect(result.cloned).toBeGreaterThan(0);
    expect(result.state.stopReason).toBe('completed');
    expect(result.state.phase).toBe('finished');
    expect(result.patch).not.toBeNull();
  });

  it('produces a patch the trusted validator accepted', async () => {
    const harness = await graphHarness({
      answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT],
    });

    const result = await runAgent(harness);

    expect(result.report?.decision).not.toBe('denied');
    expect(result.report?.changedFiles).toBeGreaterThan(0);
  });

  it('hands over only what changed, not the repository it cloned', async () => {
    const harness = await graphHarness({
      answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT],
    });

    const result = await runAgent(harness);

    expect(result.report?.changedFiles).toBe(1);
    expect(result.patch?.patch).not.toContain('README.md');
    expect(result.patch?.patch).not.toContain('src/routing/login.ts');
  });

  it('really changed the file, not just claimed to', async () => {
    const harness = await graphHarness({
      answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT],
    });

    const result = await runAgent(harness);

    expect(result.state.filesChanged).toContain('src/routing/redirect.ts');
    expect(result.patch?.patch).toContain('/home');
  });

  it('cloned at the commit the session was started from', async () => {
    const harness = await graphHarness({ answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT] });

    await runAgent(harness);

    expect(harness.source.calls[0]?.commitSha).toBe(harness.state.baseCommitSha);
  });

  it('read the code before it changed it', async () => {
    const harness = await graphHarness({ answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT] });
    const result = await runAgent(harness);
    const tools = result.state.toolEvents.map((event) => event.tool);

    expect(tools.indexOf('read_file')).toBeLessThan(tools.indexOf('apply_patch'));
  });

  it('tears the sandbox down when it finishes', async () => {
    const harness = await graphHarness({ answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT] });

    await runAgent(harness);

    expect(harness.sandbox.status().state).toBe('terminated');
  });
});

describe('a task nobody could act on', () => {
  it('asks one question and stops there', async () => {
    const harness = await graphHarness({
      task: 'make the authentication flow nicer for users',
      answers: [UNCLEAR],
    });

    const result = await runAgent(harness);

    expect(result.state.phase).toBe('clarifying');
    expect(result.state.clarificationQuestion).toBe(UNCLEAR.value.question);
    expect(result.patch).toBeNull();
  });

  it('never runs a tool before the question is answered', async () => {
    const harness = await graphHarness({
      task: 'make the authentication flow nicer for users',
      answers: [UNCLEAR],
    });

    const result = await runAgent(harness);

    expect(result.state.toolEvents).toEqual([]);
    expect(result.state.filesChanged).toEqual([]);
  });

  it('still tears the sandbox down', async () => {
    const harness = await graphHarness({
      task: 'make the authentication flow nicer for users',
      answers: [UNCLEAR],
    });

    await runAgent(harness);

    expect(harness.sandbox.status().state).toBe('terminated');
  });
});

describe('a repository that gives orders', () => {
  it('denies the command and the run carries on', async () => {
    const harness = await graphHarness({
      files: HOSTILE_REPOSITORY,
      answers: [CLEAR_SCOPE, CURL, READ, PATCH, CHECKS, COMMIT],
    });

    const result = await runAgent(harness);
    const denied = result.state.toolEvents.filter((event) => event.tool === 'run_command');

    expect(denied[0]?.outcome).toBe('refused');
    expect(result.state.stopReason).toBe('completed');
  });

  it('leaves no trace of the command it was told to run', async () => {
    const harness = await graphHarness({
      files: HOSTILE_REPOSITORY,
      answers: [CLEAR_SCOPE, CURL, READ, PATCH, CHECKS, COMMIT],
    });

    const result = await runAgent(harness);

    expect(result.patch?.patch ?? '').not.toContain('collect.example.com');
  });
});

describe('a change that needs a person', () => {
  it('pauses instead of doing it', async () => {
    const harness = await graphHarness({ answers: [CLEAR_SCOPE, WORKFLOW] });
    const result = await runAgent(harness);

    expect(result.state.phase).toBe('awaiting_approval');
    expect(result.state.stopReason).toBeNull();
    expect(result.patch).toBeNull();
  });

  it('wrote nothing while it waits', async () => {
    const harness = await graphHarness({ answers: [CLEAR_SCOPE, WORKFLOW] });

    await runAgent(harness);
    const entries = await harness.sandbox.listEntries().catch(() => []);

    expect(entries.map((entry) => entry.path)).not.toContain('.github/workflows/deploy.yml');
  });

  it('tears the sandbox down rather than paying for a wait of unknown length', async () => {
    const harness = await graphHarness({ answers: [CLEAR_SCOPE, WORKFLOW] });

    await runAgent(harness);

    expect(harness.sandbox.status().state).toBe('terminated');
  });

  it('pauses on an ordinary source file that happens to handle sessions', async () => {
    const harness = await graphHarness({
      answers: [CLEAR_SCOPE, action('apply_patch', { patch: SESSION_PATCH })],
    });

    const result = await runAgent(harness);

    expect(result.state.phase).toBe('awaiting_approval');
    expect(result.state.filesChanged).toEqual([]);
  });
});

describe('a model that will not converge', () => {
  it('is stopped by a budget, with the reason recorded', async () => {
    const harness = await graphHarness({
      budgets: { maxSteps: 4 },
      answers: [CLEAR_SCOPE, READ, READ, READ, READ, READ, READ, READ, READ],
    });

    const result = await runAgent(harness);

    expect(result.state.phase).toBe('failed');
    expect(result.state.stopReason).toBe('step_budget');
    expect(result.patch).toBeNull();
  });

  it('is stopped when it proposes the same failing thing twice', async () => {
    const missing = action('read_file', { path: 'src/auth/nowhere.ts' });
    const harness = await graphHarness({ answers: [CLEAR_SCOPE, missing, missing, missing] });

    const result = await runAgent(harness);

    expect(result.state.stopReason).toBe('repeated_action');
  });

  it('tears the sandbox down when a budget runs out', async () => {
    const harness = await graphHarness({
      budgets: { maxSteps: 3 },
      answers: [CLEAR_SCOPE, READ, READ, READ, READ, READ],
    });

    await runAgent(harness);

    expect(harness.sandbox.status().state).toBe('terminated');
  });
});

describe('finishing without having done anything', () => {
  it('refuses a commit when no file changed, and says why', async () => {
    const harness = await graphHarness({
      budgets: { maxSteps: 5 },
      answers: [CLEAR_SCOPE, COMMIT, COMMIT, COMMIT, COMMIT, COMMIT],
    });

    const result = await runAgent(harness);

    expect(result.state.stopReason).not.toBe('completed');
    expect(result.patch).toBeNull();
  });

  it('refuses a commit when the checks were never run', async () => {
    const harness = await graphHarness({
      budgets: { maxSteps: 5 },
      answers: [CLEAR_SCOPE, PATCH, COMMIT, COMMIT, COMMIT, COMMIT],
    });

    const result = await runAgent(harness);

    expect(result.state.stopReason).not.toBe('completed');
  });
});

describe('when something goes wrong', () => {
  it('still tears the sandbox down if the clone fails', async () => {
    const harness = await graphHarness({ truncated: true, answers: [CLEAR_SCOPE] });
    const result = await runAgent(harness);

    expect(result.state.stopReason).toBe('failed');
    expect(harness.sandbox.status().state).toBe('terminated');
  });
});
