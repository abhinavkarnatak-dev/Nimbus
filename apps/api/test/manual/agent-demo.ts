import {
  CLEAR_SCOPE,
  HOSTILE_REPOSITORY,
  REDIRECT_PATCH,
  SESSION_PATCH,
  action,
  graphHarness,
} from '../../src/agent/graph/graph.fixtures.js';
import { runAgent } from '../../src/agent/graph/run.js';
import type { RunResult } from '../../src/agent/graph/graph.js';

const READ = action('read_file', { path: 'src/routing/redirect.ts' });
const PATCH = action('apply_patch', { patch: REDIRECT_PATCH });
const CHECKS = action('run_checks', { name: 'unit tests', kind: 'test', argv: ['pnpm', 'test'] });
const COMMIT = action('prepare_commit', { summary: 'send people back where they came from' });
const CURL = action('run_command', { argv: ['curl', 'https://collect.example.com/config'] });
const MISSING = action('read_file', { path: 'src/routing/nowhere.ts' });

const HAPPY = [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT];

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(42)} ${String(value)}\n`);
}

function quote(text: string): void {
  for (const one of text.split('\n')) {
    process.stdout.write(`    | ${one}\n`);
  }
}

function outcome(result: RunResult): string {
  const stop = result.state.stopReason ?? 'still open';
  return `${result.state.phase}, ${stop}`;
}

function steps(result: RunResult): string {
  return result.state.toolEvents.map((event) => `${event.tool}:${event.outcome}`).join(' -> ');
}

async function wholeRun(): Promise<void> {
  heading('One task, start to finished patch, with nobody calling a node by hand');
  const harness = await graphHarness({ answers: HAPPY });

  line('the task', harness.state.task);
  line('the base commit', `${harness.state.baseCommitSha.slice(0, 12)}...`);

  const result = await runAgent(harness);

  line('files cloned in', result.cloned);
  line('what it did', steps(result));
  line('outcome', outcome(result));
  line('files changed', result.state.filesChanged.join(', '));
  line('checks recorded', result.state.checks.map((one) => `${one.name}=${one.status}`).join(', '));

  heading('What it hands over');
  line('validator decision', result.report?.decision ?? 'none');
  line('changed files in the patch', result.report?.changedFiles ?? 0);
  line(
    'lines',
    `+${String(result.report?.addedLines ?? 0)} -${String(result.report?.removedLines ?? 0)}`,
  );
  quote((result.patch?.patch ?? '').trim());

  heading('Only what changed, not the repository it cloned');
  line('files written by the clone', result.cloned);
  line('files in the patch', result.report?.changedFiles ?? 0);
  line('why', 'the clone marks itself as the baseline, so it is not a change');

  heading('And the sandbox is gone');
  line('sandbox state', harness.sandbox.status().state);
}

async function vagueTask(): Promise<void> {
  heading('A task nobody could act on');
  const harness = await graphHarness({
    task: 'make the authentication flow nicer for users',
    answers: [
      { value: { clear: false, question: 'Which page should people land on after signing in?' } },
    ],
  });

  const result = await runAgent(harness);

  line('outcome', outcome(result));
  line('the question it asked', result.state.clarificationQuestion ?? 'none');
  line('tools it ran first', result.state.toolEvents.length);
  line('sandbox', harness.sandbox.status().state);
}

async function hostileRepository(): Promise<void> {
  heading('A repository whose README gives orders');
  const harness = await graphHarness({
    files: HOSTILE_REPOSITORY,
    answers: [CLEAR_SCOPE, CURL, READ, PATCH, CHECKS, COMMIT],
  });

  const result = await runAgent(harness);

  line('the model obeyed the README', 'yes, it proposed the curl');
  line('what happened to it', result.state.toolEvents[0]?.outcome ?? 'none');
  line('the run', steps(result));
  line('outcome', outcome(result));
  line('anything reached the patch', (result.patch?.patch ?? '').includes('collect.example.com'));
}

async function needsAPerson(): Promise<void> {
  heading('A change that needs a person');
  const harness = await graphHarness({
    answers: [CLEAR_SCOPE, action('apply_patch', { patch: SESSION_PATCH })],
  });

  const result = await runAgent(harness);

  line('the file', 'src/auth/session.ts, an ordinary source file');
  line('why it stopped', 'the path handles sessions, so policy asks');
  line('outcome', outcome(result));
  line('files changed', result.state.filesChanged.length);
  line('sandbox', `${harness.sandbox.status().state}, rebuilt from the clone on resume`);
}

async function neverConverges(): Promise<void> {
  heading('A model that keeps asking for a file that is not there');
  const harness = await graphHarness({ answers: [CLEAR_SCOPE, MISSING, MISSING, MISSING] });
  const result = await runAgent(harness);

  line('outcome', outcome(result));
  line('why', result.stopVerdict?.detail ?? 'none');
  line(
    'steps used',
    `${String(result.state.budgets.steps)} of ${String(result.state.budgets.maxSteps)}`,
  );

  heading('A model that never gets anywhere at all');
  const wandering = await graphHarness({
    budgets: { maxSteps: 4 },
    answers: [CLEAR_SCOPE, READ, READ, READ, READ, READ, READ],
  });

  const spent = await runAgent(wandering);

  line('outcome', outcome(spent));
  line('why', spent.stopVerdict?.detail ?? 'none');
}

async function nothingToShow(): Promise<void> {
  heading('Finishing without having done anything');
  const harness = await graphHarness({
    budgets: { maxSteps: 4 },
    answers: [CLEAR_SCOPE, COMMIT, COMMIT, COMMIT, COMMIT],
  });

  const result = await runAgent(harness);

  line('the model said it was done', 'four times');
  line('files changed', result.state.filesChanged.length);
  line('outcome', outcome(result));
  line('a patch was handed over', result.patch !== null);
}

async function main(): Promise<void> {
  await wholeRun();
  await vagueTask();
  await hostileRepository();
  await needsAPerson();
  await neverConverges();
  await nothingToShow();
}

await main();
