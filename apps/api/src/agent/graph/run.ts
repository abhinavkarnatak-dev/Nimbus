import { alerting } from '../../logging/alerts.js';
import type { SandboxTerminationReason } from '../../sandbox/index.js';
import { stopped } from '../state/state.js';
import { buildAgentGraph, type RunInput, type RunResult } from './graph.js';

const RECURSION_HEADROOM = 6;

function terminationFor(result: RunResult): SandboxTerminationReason {
  if (result.state.stopReason === 'cancelled') {
    return 'cancelled';
  }

  if (result.state.phase === 'awaiting_approval' || result.state.phase === 'clarifying') {
    return 'completed';
  }

  return result.state.stopReason === null || result.state.stopReason === 'completed'
    ? 'completed'
    : 'failed';
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  input.router.restoreBudget(input.state.budgets.llm);

  const graph = buildAgentGraph(input);
  const config = {
    recursionLimit: input.state.budgets.maxSteps * 3 + RECURSION_HEADROOM,
    ...(input.checkpointer === undefined
      ? {}
      : { configurable: { thread_id: input.state.sessionId, checkpoint_ns: '' } }),
  };

  let result: RunResult | null = null;

  try {
    const finished = await graph.invoke({ state: input.state }, config);

    result = {
      state: finished.state,
      patch: finished.patch,
      report: finished.patch?.report ?? null,
      stopVerdict: finished.verdict,
      cloned: finished.cloned,
      steps: finished.state.budgets.steps,
    };
  } catch (error) {
    input.logger.error(
      { sessionId: input.state.sessionId, ...describeFailure(error) },
      'an agent run did not finish',
    );

    result = {
      state: stopped(input.state, 'failed'),
      patch: null,
      report: null,
      stopVerdict: { stop: true, reason: 'failed', detail: 'the run did not finish' },
      cloned: 0,
      steps: input.state.budgets.steps,
      threw: error,
    };
  } finally {
    await tearDown(input, result);
  }

  return result;
}

export function describeFailure(error: unknown): {
  error: string;
  code: string | null;
  detail: string | null;
} {
  if (typeof error !== 'object' || error === null) {
    return { error: String(error), code: null, detail: null };
  }

  const held = error as { code?: unknown; detail?: unknown; message?: unknown };

  return {
    error: typeof held.message === 'string' ? held.message : 'something with no message was thrown',
    code: typeof held.code === 'string' ? held.code : null,
    detail: typeof held.detail === 'string' ? held.detail : null,
  };
}

async function tearDown(input: RunInput, result: RunResult | null): Promise<void> {
  try {
    await input.sandbox.terminate(result === null ? 'failed' : terminationFor(result));
  } catch (error) {
    input.logger.warn(
      alerting('sandbox_cleanup_failed', {
        sessionId: input.state.sessionId,
        error: String(error),
      }),
      'a sandbox could not be torn down',
    );
  }
}
