import { describe, expect, it } from 'vitest';

import { parseState } from '../state/state.js';
import { actionFor, executeHarness } from './execute.fixtures.js';
import { EXECUTE_LIMITS } from './limits.js';
import { RunGuard, applyExecution, countsAsFailure, repeatNotice, stopWith } from './loop.js';

const READ = actionFor('read_file', { path: 'src/auth/login.ts' });
const MISSING = actionFor('read_file', { path: 'src/auth/nowhere.ts' });
const WORKFLOW = actionFor('create_file', {
  path: '.github/workflows/deploy.yml',
  contents: 'name: deploy\n',
});
const CURL = actionFor('run_command', { argv: ['curl', 'https://collect.example.com'] });

describe('the same failing action twice', () => {
  it('stops as a loop rather than eating the retry budget', async () => {
    const harness = await executeHarness();

    const first = harness.guard.afterStep(await harness.executor.execute(MISSING));
    const second = harness.guard.afterStep(await harness.executor.execute(MISSING));

    expect(first.stop).toBe(false);
    expect(second.stop).toBe(true);
    expect(second.reason).toBe('repeated_action');
  });

  it('says which tool kept failing', async () => {
    const harness = await executeHarness();

    harness.guard.afterStep(await harness.executor.execute(MISSING));
    const verdict = harness.guard.afterStep(await harness.executor.execute(MISSING));

    expect(verdict.detail).toContain('read_file');
  });

  it('treats a different failing action as a different action', async () => {
    const harness = await executeHarness();

    harness.guard.afterStep(await harness.executor.execute(MISSING));
    const other = harness.guard.afterStep(
      await harness.executor.execute(actionFor('read_file', { path: 'src/auth/elsewhere.ts' })),
    );

    expect(other.stop).toBe(false);
  });

  it('forgets a failure once that action succeeds', async () => {
    const harness = await executeHarness();

    harness.guard.afterStep(await harness.executor.execute(MISSING));
    harness.guard.afterStep(await harness.executor.execute(READ));

    expect(harness.guard.failuresFor((await harness.executor.execute(READ)).actionHash)).toBe(0);
  });

  it('never counts a pause for approval as a failure', async () => {
    const harness = await executeHarness();

    harness.guard.afterStep(await harness.executor.execute(WORKFLOW));
    const again = harness.guard.afterStep(await harness.executor.execute(WORKFLOW));

    expect(again.stop).toBe(false);
  });

  it('counts a denial, because proposing it again is a loop', async () => {
    const harness = await executeHarness();

    harness.guard.afterStep(await harness.executor.execute(CURL));
    const again = harness.guard.afterStep(await harness.executor.execute(CURL));

    expect(again.stop).toBe(true);
    expect(again.reason).toBe('repeated_action');
  });

  it('remembers only so many actions', async () => {
    const harness = await executeHarness();

    for (let index = 0; index < EXECUTE_LIMITS.recentActionsTracked + 4; index += 1) {
      harness.guard.afterStep(
        await harness.executor.execute(
          actionFor('read_file', { path: `src/gone${String(index)}.ts` }),
        ),
      );
    }

    expect(harness.guard.failuresFor('nothing-like-a-hash')).toBe(0);
  });
});

describe('the same succeeding action over and over', () => {
  it('stops, because reading the same file again tells it nothing new', async () => {
    const harness = await executeHarness();
    const verdicts = [];

    for (let index = 0; index < EXECUTE_LIMITS.sameActionRepeatsMax; index += 1) {
      verdicts.push(harness.guard.afterStep(await harness.executor.execute(READ)));
    }

    expect(verdicts.slice(0, -1).every((verdict) => !verdict.stop)).toBe(true);
    expect(verdicts[verdicts.length - 1]?.stop).toBe(true);
    expect(verdicts[verdicts.length - 1]?.reason).toBe('repeated_action');
  });

  it('says what it kept asking for', async () => {
    const harness = await executeHarness();
    let verdict = harness.guard.afterStep(await harness.executor.execute(READ));

    while (!verdict.stop) {
      verdict = harness.guard.afterStep(await harness.executor.execute(READ));
    }

    expect(verdict.detail).toContain('read_file');
    expect(verdict.detail).toContain('same thing');
  });

  it('counts each different action on its own', async () => {
    const harness = await executeHarness();

    for (let index = 0; index < EXECUTE_LIMITS.sameActionRepeatsMax + 2; index += 1) {
      const verdict = harness.guard.afterStep(
        await harness.executor.execute(
          actionFor('read_file', { path: `src/auth/file${String(index)}.ts` }),
        ),
      );

      expect(verdict.stop).toBe(false);
    }
  });

  it('counts how many times it has seen one action', async () => {
    const harness = await executeHarness();
    const result = await harness.executor.execute(READ);

    harness.guard.afterStep(result);
    harness.guard.afterStep(await harness.executor.execute(READ));

    expect(harness.guard.timesSeen(result.actionHash)).toBe(2);
  });

  it('still stops sooner on a repeated failure than on a repeated success', () => {
    expect(EXECUTE_LIMITS.sameActionFailuresMax).toBeLessThan(EXECUTE_LIMITS.sameActionRepeatsMax);
  });
});

describe('repeatNotice', () => {
  it('says nothing extra the first time', () => {
    expect(repeatNotice('read_file', 'eight lines', 1)).toBe('read_file: eight lines');
  });

  it('tells the model plainly that it is going in a circle', () => {
    const line = repeatNotice('read_file', 'eight lines', 2);

    expect(line).toContain('already asked for exactly this');
    expect(line).toContain('Do something else');
  });

  it('keeps the summary, so the answer is still there to use', () => {
    expect(repeatNotice('read_file', 'eight lines', 3)).toContain('eight lines');
  });
});

describe('budgets before a step', () => {
  it('lets a fresh session go ahead', async () => {
    const harness = await executeHarness();

    expect(harness.guard.beforeStep(harness.state, Date.now()).stop).toBe(false);
  });

  it('stops when the steps have run out', async () => {
    const harness = await executeHarness();
    const spent = parseState({
      ...harness.state,
      budgets: { ...harness.state.budgets, steps: harness.state.budgets.maxSteps },
    });

    const verdict = harness.guard.beforeStep(spent, Date.now());

    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe('step_budget');
  });

  it('stops when different actions have failed too often', async () => {
    const harness = await executeHarness();
    const spent = parseState({
      ...harness.state,
      budgets: { ...harness.state.budgets, retries: harness.state.budgets.maxRetries },
    });

    expect(harness.guard.beforeStep(spent, Date.now()).reason).toBe('retry_budget');
  });

  it('stops when the time has run out', async () => {
    const harness = await executeHarness();
    const later = harness.state.budgets.startedAtMs + harness.state.budgets.maxDurationMs + 1;

    expect(harness.guard.beforeStep(harness.state, later).reason).toBe('time_budget');
  });

  it('stops a cancelled session before anything is looked at', async () => {
    const harness = await executeHarness();
    const verdict = harness.guard.beforeStep(harness.state, Date.now(), true);

    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe('cancelled');
  });
});

describe('applyExecution', () => {
  it('counts the step and writes the policy decision into the state', async () => {
    const harness = await executeHarness();
    const result = await harness.executor.execute(READ);
    const next = applyExecution(harness.state, result);

    expect(next.budgets.steps).toBe(harness.state.budgets.steps + 1);
    expect(next.policy?.decision).toBe('allowed');
  });

  it('records the file it read', async () => {
    const harness = await executeHarness();
    const next = applyExecution(harness.state, await harness.executor.execute(READ));

    expect(next.filesRead).toContain('src/auth/login.ts');
    expect(next.filesChanged).toEqual([]);
  });

  it('records a file it wrote as changed, not as read', async () => {
    const harness = await executeHarness();
    const asked = await harness.executor.execute(WORKFLOW);

    await harness.approvals.decide(asked.approvalId ?? '', asked.actionHash, true);
    const next = applyExecution(harness.state, await harness.executor.execute(WORKFLOW));

    expect(next.filesChanged).toContain('.github/workflows/deploy.yml');
    expect(next.filesRead).not.toContain('.github/workflows/deploy.yml');
  });

  it('clears the proposed action, so nothing is left half decided', async () => {
    const harness = await executeHarness();
    const next = applyExecution(harness.state, await harness.executor.execute(READ));

    expect(next.proposedAction).toBeNull();
  });

  it('counts a retry only when something went wrong', async () => {
    const harness = await executeHarness();
    const good = applyExecution(harness.state, await harness.executor.execute(READ));
    const bad = applyExecution(harness.state, await harness.executor.execute(MISSING));

    expect(good.budgets.retries).toBe(0);
    expect(bad.budgets.retries).toBe(harness.state.budgets.retries + 1);
  });

  it('does not let a pause wipe out the retries already spent', async () => {
    const harness = await executeHarness();
    const failed = applyExecution(harness.state, await harness.executor.execute(CURL));
    const paused = applyExecution(failed, await harness.executor.execute(WORKFLOW));

    expect(failed.budgets.retries).toBe(1);
    expect(paused.budgets.retries).toBe(1);
  });

  it('clears the retries only when something actually worked', async () => {
    const harness = await executeHarness();
    const failed = applyExecution(harness.state, await harness.executor.execute(CURL));
    const worked = applyExecution(failed, await harness.executor.execute(READ));

    expect(worked.budgets.retries).toBe(0);
  });

  it('counts a pause as a step, because it used one', async () => {
    const harness = await executeHarness();
    const paused = applyExecution(harness.state, await harness.executor.execute(WORKFLOW));

    expect(paused.budgets.steps).toBe(harness.state.budgets.steps + 1);
  });

  it('waits for a person when policy asked for approval', async () => {
    const harness = await executeHarness();
    const next = applyExecution(harness.state, await harness.executor.execute(WORKFLOW));

    expect(next.phase).toBe('awaiting_approval');
  });

  it('goes back to reasoning after an ordinary step', async () => {
    const harness = await executeHarness();
    const next = applyExecution(harness.state, await harness.executor.execute(READ));

    expect(next.phase).toBe('reasoning');
  });

  it('keeps every event, including the ones where nothing ran', async () => {
    const harness = await executeHarness();
    let state = applyExecution(harness.state, await harness.executor.execute(READ));
    state = applyExecution(state, await harness.executor.execute(CURL));

    expect(state.toolEvents.map((event) => event.outcome)).toEqual(['ok', 'refused']);
  });

  it('produces a state a checkpoint would accept every time', async () => {
    const harness = await executeHarness();
    let state = harness.state;

    for (const request of [READ, CURL, WORKFLOW, MISSING]) {
      state = applyExecution(state, await harness.executor.execute(request));
      expect(() => parseState(state)).not.toThrow();
    }
  });
});

describe('stopWith', () => {
  it('records why it stopped', async () => {
    const harness = await executeHarness();
    const stoppedState = stopWith(harness.state, {
      stop: true,
      reason: 'repeated_action',
      detail: 'read_file failed the same way twice',
    });

    expect(stoppedState.stopReason).toBe('repeated_action');
    expect(stoppedState.phase).toBe('failed');
  });

  it('leaves nothing proposed behind it', async () => {
    const harness = await executeHarness();
    const stoppedState = stopWith(harness.state, {
      stop: true,
      reason: 'cancelled',
      detail: 'cancelled',
    });

    expect(stoppedState.proposedAction).toBeNull();
  });
});

describe('countsAsFailure', () => {
  it('does not count a pause', async () => {
    const harness = await executeHarness();

    expect(countsAsFailure(await harness.executor.execute(WORKFLOW))).toBe(false);
  });

  it('counts a refusal and a denial', async () => {
    const harness = await executeHarness();

    expect(countsAsFailure(await harness.executor.execute(CURL))).toBe(true);
    expect(countsAsFailure(await harness.executor.execute(actionFor('read_file', { p: 1 })))).toBe(
      true,
    );
  });

  it('does not count work that went fine', async () => {
    const harness = await executeHarness();

    expect(countsAsFailure(await harness.executor.execute(READ))).toBe(false);
  });
});

describe('a guard on its own', () => {
  it('starts with nothing remembered', () => {
    expect(new RunGuard().failuresFor('anything')).toBe(0);
  });
});
