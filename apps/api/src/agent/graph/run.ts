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
      { sessionId: input.state.sessionId, error: String(error) },
      'an agent run did not finish',
    );

    result = {
      state: stopped(input.state, 'failed'),
      patch: null,
      report: null,
      stopVerdict: { stop: true, reason: 'failed', detail: 'the run did not finish' },
      cloned: 0,
      steps: input.state.budgets.steps,
    };
  } finally {
    await tearDown(input, result);
  }

  return result;
}

async function tearDown(input: RunInput, result: RunResult | null): Promise<void> {
  try {
    await input.sandbox.terminate(result === null ? 'failed' : terminationFor(result));
  } catch (error) {
    input.logger.warn(
      { sessionId: input.state.sessionId, error: String(error) },
      'a sandbox could not be torn down',
    );
  }
}
