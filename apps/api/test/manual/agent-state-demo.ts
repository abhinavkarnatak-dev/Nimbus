import { REAL_LOOKING_TOKEN, sampleState } from '../../src/agent/state/agent-state.fixtures.js';
import {
  AgentStateError,
  assertRoom,
  deserializeState,
  newBudgets,
  recordFileRead,
  recordToolEvent,
  resumeLlmBudget,
  serializeState,
  shortfall,
  stopped,
  takeStep,
  withPhase,
} from '../../src/agent/state/index.js';
import { SessionBudget } from '../../src/llm/index.js';
import { buildReport } from '../../src/llm/provider.js';

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(30)} ${String(value)}\n`);
}

function refusal(work: () => unknown): string {
  try {
    work();
    return 'it was accepted, which it should not have been';
  } catch (error) {
    return error instanceof AgentStateError ? error.code : 'an unexpected failure';
  }
}

function spentBudget(tokens: number): SessionBudget {
  const budget = new SessionBudget();
  budget.charge(
    buildReport({
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      usage: { promptTokens: tokens, completionTokens: 0, reasoningTokens: 0, totalTokens: tokens },
      attempts: 1,
      durationMs: 1,
    }),
  );
  return budget;
}

function main(): void {
  heading('A session that has done some work');
  let state = sampleState();
  state = withPhase(state, 'executing');
  state = recordFileRead(state, 'src/auth/login.ts');
  state = recordFileRead(state, 'src/auth/redirect.ts');
  state = recordToolEvent(state, {
    step: 1,
    tool: 'read_file',
    outcome: 'ok',
    summary: 'read the redirect helper',
    atMs: Date.now(),
  });

  line('phase', state.phase);
  line('files read', state.filesRead.length);
  line('tool events', state.toolEvents.length);

  heading('Writing it down and reading it back');
  const bytes = serializeState(state);
  const back = deserializeState(bytes);

  line('bytes', bytes.length);
  line('identical after a round trip', JSON.stringify(back) === JSON.stringify(state));
  line('phase survived', back.phase);
  line('files survived', back.filesRead.join(', '));

  heading('What it refuses to write down');
  line(
    'a github token in the task',
    refusal(() => serializeState({ ...state, task: `use ${REAL_LOOKING_TOKEN}` })),
  );
  line(
    'a connection string',
    refusal(() => serializeState({ ...state, task: 'mongodb://u:p@host/db' })),
  );
  line(
    'a field named apiKey',
    refusal(() => serializeState({ ...state, apiKey: 'x' } as never)),
  );
  line('  the schema caught that', 'before the credential check even ran');
  line(
    'a live object',
    refusal(() => serializeState({ ...state, sandbox: new Map() } as never)),
  );
  line(
    'a field nobody asked for',
    refusal(() => serializeState({ ...state, extra: 1 } as never)),
  );
  line('it refuses rather than', 'redacting, so a resumed state is never a lie');

  heading('What it refuses to read back');
  line(
    'bytes that are not json',
    refusal(() => deserializeState('{not json')),
  );
  line(
    'json that is not a state',
    refusal(() => deserializeState('{"hello":"world"}')),
  );

  heading('Four ways a session can run away');
  const now = Date.now();
  const budgets = [
    ['steps', { ...newBudgets({ startedAtMs: now, maxSteps: 3 }), steps: 3 }],
    ['retries', { ...newBudgets({ startedAtMs: now, maxRetries: 2 }), retries: 2 }],
    ['time', newBudgets({ startedAtMs: now - 10_000, maxDurationMs: 5_000 })],
    ['tokens', newBudgets({ startedAtMs: now, llm: spentBudget(400_000) })],
  ] as const;

  for (const [label, budget] of budgets) {
    line(label, shortfall(budget, now)?.reason ?? 'still has room');
  }

  heading('Stopping safely');
  const tight = { ...newBudgets({ maxSteps: 1 }), steps: 1 };
  let code = '';

  try {
    assertRoom(tight);
  } catch (error) {
    code =
      error instanceof AgentStateError ? `${error.code}, ${String(error.detail)}` : 'unexpected';
  }

  line('checked before the work', code);
  line('nothing was half done', 'the step was never taken');
  line('the session says why', stopped(state, 'step_budget').stopReason);

  heading('Spending survives a restart');
  const before = newBudgets({ llm: spentBudget(1_234) });
  const afterRestart = resumeLlmBudget(
    deserializeState(serializeState({ ...state, budgets: before })).budgets,
  );

  line('tokens spent before', before.llm.tokensUsed);
  line('tokens spent after resume', afterRestart.state().tokensUsed);
  line('a fresh budget would say', 0);
  line('steps taken', takeStep(before).steps);
}

main();
