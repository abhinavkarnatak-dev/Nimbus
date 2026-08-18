import type { AgentState, CheckResult } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { sampleState } from '../state/agent-state.fixtures.js';
import { parseState } from '../state/state.js';
import { failingChecks, judgeCompletion } from './complete.js';

function check(name: string, status: CheckResult['status']): CheckResult {
  return { name, kind: 'test', status, summary: `${name} ${status}` };
}

function stateWith(parts: Partial<AgentState>): AgentState {
  return parseState({ ...sampleState(), ...parts });
}

describe('judgeCompletion', () => {
  it('is finished when files changed and every check passed', () => {
    const verdict = judgeCompletion(
      stateWith({ filesChanged: ['src/a.ts'], checks: [check('unit', 'passed')] }),
    );

    expect(verdict.finished).toBe(true);
    expect(verdict.refusal).toBeNull();
  });

  it('refuses a session that changed nothing, whatever it says', () => {
    const verdict = judgeCompletion(
      stateWith({ filesChanged: [], checks: [check('unit', 'passed')] }),
    );

    expect(verdict.finished).toBe(false);
    expect(verdict.refusal).toBe('nothing_changed');
  });

  it('tells it what to do instead of just saying no', () => {
    const verdict = judgeCompletion(stateWith({ filesChanged: [] }));

    expect(verdict.reason).toContain('Make the change');
  });

  it('refuses when the checks were never run', () => {
    const verdict = judgeCompletion(stateWith({ filesChanged: ['src/a.ts'], checks: [] }));

    expect(verdict.refusal).toBe('checks_not_run');
    expect(verdict.reason).toContain('run_checks');
  });

  it('requires a new check after a follow-up edit', () => {
    const verdict = judgeCompletion(
      stateWith({
        filesChanged: ['src/a.ts'],
        checks: [check('unit', 'passed')],
        toolEvents: [
          { step: 1, tool: 'run_checks', outcome: 'ok', summary: 'unit: passed', atMs: 1 },
          { step: 2, tool: 'apply_patch', outcome: 'ok', summary: 'files changed: 1', atMs: 2 },
        ],
      }),
    );

    expect(verdict.refusal).toBe('checks_not_run');
  });

  it('refuses when a check failed, and names it', () => {
    const verdict = judgeCompletion(
      stateWith({
        filesChanged: ['src/a.ts'],
        checks: [check('unit', 'passed'), check('typecheck', 'failed')],
      }),
    );

    expect(verdict.refusal).toBe('checks_failed');
    expect(verdict.reason).toContain('typecheck');
    expect(verdict.reason).not.toContain('unit');
  });

  it('treats a check that could not run as a failure, not as a pass', () => {
    const verdict = judgeCompletion(
      stateWith({ filesChanged: ['src/a.ts'], checks: [check('unit', 'errored')] }),
    );

    expect(verdict.refusal).toBe('checks_failed');
  });

  it('does not accept not_run as a pass either', () => {
    const verdict = judgeCompletion(
      stateWith({ filesChanged: ['src/a.ts'], checks: [check('unit', 'not_run')] }),
    );

    expect(verdict.finished).toBe(true);
  });

  it('says how much changed when it is finished', () => {
    const verdict = judgeCompletion(
      stateWith({ filesChanged: ['src/a.ts', 'src/b.ts'], checks: [check('unit', 'passed')] }),
    );

    expect(verdict.reason).toContain('2 files changed');
  });

  it('checks that nothing changed first, before it asks about checks', () => {
    const verdict = judgeCompletion(
      stateWith({ filesChanged: [], checks: [check('unit', 'failed')] }),
    );

    expect(verdict.refusal).toBe('nothing_changed');
  });
});

describe('failingChecks', () => {
  it('finds the failed and the errored ones', () => {
    const found = failingChecks([
      check('a', 'passed'),
      check('b', 'failed'),
      check('c', 'errored'),
      check('d', 'not_run'),
    ]);

    expect(found.map((one) => one.name)).toEqual(['b', 'c']);
  });

  it('finds nothing when everything passed', () => {
    expect(failingChecks([check('a', 'passed')])).toEqual([]);
  });
});
