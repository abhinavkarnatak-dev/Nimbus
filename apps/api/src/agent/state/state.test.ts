import { AGENT_STATE_VERSION, MAX_FILES_READ, MAX_TOOL_EVENTS } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { REAL_LOOKING_TOKEN, sampleState, stateInput } from './agent-state.fixtures.js';
import { STATE_LIMITS } from './limits.js';
import {
  createState,
  deserializeState,
  parseState,
  recordFileChanged,
  recordFileRead,
  recordToolEvent,
  serializeState,
  stopped,
  withPhase,
} from './state.js';

function event(step: number): {
  step: number;
  tool: string;
  outcome: 'ok';
  summary: string;
  atMs: number;
} {
  return {
    step,
    tool: 'read_file',
    outcome: 'ok',
    summary: `read a file at ${String(step)}`,
    atMs: 1,
  };
}

describe('createState', () => {
  it('starts a session that has not done anything yet', () => {
    const state = createState(stateInput());

    expect(state.version).toBe(AGENT_STATE_VERSION);
    expect(state.phase).toBe('starting');
    expect(state.stopReason).toBeNull();
    expect(state.budgets.steps).toBe(0);
    expect(state.filesRead).toEqual([]);
    expect(state.proposedAction).toBeNull();
  });

  it('holds the things that must never change', () => {
    const state = createState(stateInput());

    expect(state.baseCommitSha).toBe(stateInput().baseCommitSha);
    expect(state.defaultBranch).toBe('main');
    expect(state.sessionId).toBe(stateInput().sessionId);
  });

  it('refuses a task that is too long', () => {
    expect(() => createState(stateInput({ task: 'a'.repeat(5_000) }))).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }) as Error,
    );
  });

  it('refuses a commit that is not a commit', () => {
    expect(() => createState(stateInput({ baseCommitSha: 'main' }))).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }) as Error,
    );
  });
});

describe('parseState', () => {
  it('refuses a field nobody asked for', () => {
    expect(() => parseState({ ...sampleState(), secretPlan: 'x' })).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }) as Error,
    );
  });

  it('refuses an array that is too long', () => {
    const filesRead = Array.from({ length: MAX_FILES_READ + 1 }, (_v, i) => `src/f${String(i)}.ts`);

    expect(() => parseState({ ...sampleState(), filesRead })).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }) as Error,
    );
  });

  it('refuses a snippet that is too long', () => {
    const retrieved = [
      {
        path: 'a.ts',
        startLine: 1,
        endLine: 2,
        snippet: 'x'.repeat(STATE_LIMITS.snippetMaxChars + 1),
      },
    ];

    expect(() => parseState({ ...sampleState(), retrieved })).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }) as Error,
    );
  });

  it('names the fields that were wrong without quoting them', () => {
    let detail = '';

    try {
      parseState({ ...sampleState(), task: '' });
    } catch (error) {
      detail = (error as { detail: string }).detail;
    }

    expect(detail).toContain('task');
  });

  it('refuses a state from a version it does not know', () => {
    expect(() => parseState({ ...sampleState(), version: 99 })).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }) as Error,
    );
  });
});

describe('serialize and read back', () => {
  it('comes back exactly as it went in', () => {
    const state = sampleState();
    expect(deserializeState(serializeState(state))).toEqual(state);
  });

  it('survives a state that has done some work', () => {
    let state = sampleState();
    state = withPhase(state, 'executing');
    state = recordFileRead(state, 'src/auth/login.ts');
    state = recordFileChanged(state, 'src/auth/redirect.ts');
    state = recordToolEvent(state, event(1));

    const back = deserializeState(serializeState(state));

    expect(back).toEqual(state);
    expect(back.filesRead).toEqual(['src/auth/login.ts']);
    expect(back.toolEvents).toHaveLength(1);
  });

  it('refuses to write a state holding something that looks like a token', () => {
    const state = { ...sampleState(), task: `use ${REAL_LOOKING_TOKEN} to push` };

    expect(() => serializeState(state)).toThrow(
      expect.objectContaining({ code: 'STATE_HOLDS_CREDENTIAL' }) as Error,
    );
  });

  it('refuses rather than redacting, so a resumed state is never a lie', () => {
    const state = { ...sampleState(), task: `use ${REAL_LOOKING_TOKEN} to push` };
    const outcomes: string[] = [];

    try {
      outcomes.push(serializeState(state));
    } catch {
      outcomes.push('refused');
    }

    expect(outcomes).toEqual(['refused']);
  });

  it('refuses a token hidden in a tool summary', () => {
    const state = recordToolEvent(sampleState(), {
      ...event(1),
      summary: `ran with ${REAL_LOOKING_TOKEN}`,
    });

    expect(() => serializeState(state)).toThrow(
      expect.objectContaining({ code: 'STATE_HOLDS_CREDENTIAL' }) as Error,
    );
  });

  it('reads back nothing usable from bytes that are not json', () => {
    expect(() => deserializeState('{not json at all')).toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_CORRUPT' }) as Error,
    );
  });

  it('reads back nothing usable from json that is not a state', () => {
    expect(() => deserializeState('{"hello":"world"}')).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }) as Error,
    );
  });
});

describe('moving through the run', () => {
  it('changes phase', () => {
    expect(withPhase(sampleState(), 'reasoning').phase).toBe('reasoning');
  });

  it('finishes cleanly when it completed', () => {
    const state = stopped(sampleState(), 'completed');

    expect(state.phase).toBe('finished');
    expect(state.stopReason).toBe('completed');
  });

  it('fails and says which budget ran out', () => {
    const state = stopped(sampleState(), 'step_budget');

    expect(state.phase).toBe('failed');
    expect(state.stopReason).toBe('step_budget');
  });

  it('drops a proposed action when it stops, so nothing is left half decided', () => {
    const withAction = parseState({
      ...sampleState(),
      proposedAction: {
        tool: 'apply_patch',
        reason: 'fix the redirect',
        argumentsJson: '{}',
        actionHash: 'a'.repeat(64),
      },
    });

    expect(stopped(withAction, 'cancelled').proposedAction).toBeNull();
  });

  it('never records the same file read twice', () => {
    let state = recordFileRead(sampleState(), 'src/a.ts');
    state = recordFileRead(state, 'src/a.ts');

    expect(state.filesRead).toEqual(['src/a.ts']);
  });

  it('never records the same changed file twice', () => {
    let state = recordFileChanged(sampleState(), 'src/a.ts');
    state = recordFileChanged(state, 'src/a.ts');

    expect(state.filesChanged).toEqual(['src/a.ts']);
  });

  it('keeps only the most recent tool events rather than growing forever', () => {
    let state = sampleState();

    for (let step = 0; step < MAX_TOOL_EVENTS + 10; step += 1) {
      state = recordToolEvent(state, event(step));
    }

    expect(state.toolEvents).toHaveLength(MAX_TOOL_EVENTS);
    expect(state.toolEvents[state.toolEvents.length - 1]?.step).toBe(MAX_TOOL_EVENTS + 9);
  });

  it('keeps only the most recent files read', () => {
    let state = sampleState();

    for (let index = 0; index < MAX_FILES_READ + 5; index += 1) {
      state = recordFileRead(state, `src/f${String(index)}.ts`);
    }

    expect(state.filesRead).toHaveLength(MAX_FILES_READ);
  });

  it('stays serializable however much work it has done', () => {
    let state = sampleState();

    for (let step = 0; step < MAX_TOOL_EVENTS + 10; step += 1) {
      state = recordToolEvent(state, event(step));
      state = recordFileRead(state, `src/f${String(step)}.ts`);
    }

    expect(() => serializeState(state)).not.toThrow();
    expect(Buffer.byteLength(serializeState(state), 'utf8')).toBeLessThan(
      STATE_LIMITS.checkpointMaxBytes,
    );
  });
});
