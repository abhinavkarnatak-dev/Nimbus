import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { AgentState, DescribedImage, PatchValidationReport } from '@nimbus/contracts';

import type { Logger } from '../../logging/logger.js';
import type { AttachedText } from '../../routing/context.js';
import type { SessionRouter } from '../../routing/router.js';
import type { Sandbox } from '../../sandbox/index.js';
import type { RepositoryReference, RepositorySource } from '../clone/index.js';
import type { ActionExecutor } from '../execute/executor.js';
import {
  RunGuard,
  applyExecution,
  repeatNotice,
  stopWith,
  type StopVerdict,
} from '../execute/loop.js';
import { chooseNextAction } from '../nodes/reason.js';
import { gatherContext } from '../nodes/retrieve.js';
import { validateScope } from '../nodes/scope.js';
import type { ToolRegistry } from '../registry/registry.js';
import { parseState, recordToolEvent, stopped, withPhase } from '../state/state.js';
import { judgeCompletion } from './complete.js';
import { GRAPH_LIMITS } from './limits.js';
import { preparePatch, type PreparedPatch } from './patch.js';

export interface RunInput {
  state: AgentState;
  sandbox: Sandbox;
  registry: ToolRegistry;
  router: SessionRouter;
  executor: ActionExecutor;
  source: RepositorySource;
  reference: RepositoryReference;
  logger: Logger;
  images?: readonly DescribedImage[];
  attachments?: readonly AttachedText[];
  checkpointer?: BaseCheckpointSaver;
  signal?: AbortSignal;
}

export interface RunResult {
  state: AgentState;
  patch: PreparedPatch | null;
  report: PatchValidationReport | null;
  stopVerdict: StopVerdict | null;
  cloned: number;
  steps: number;
}

interface Carried {
  state: AgentState;
  context: string;
  history: string[];
  patch: PreparedPatch | null;
  verdict: StopVerdict | null;
  cloned: number;
  done: boolean;
}

const RunAnnotation = Annotation.Root({
  state: Annotation<AgentState>({ reducer: (_held, next) => next }),
  context: Annotation<string>({ reducer: (_held, next) => next, default: () => '' }),
  history: Annotation<string[]>({ reducer: (_held, next) => next, default: () => [] }),
  patch: Annotation<PreparedPatch | null>({ reducer: (_held, next) => next, default: () => null }),
  verdict: Annotation<StopVerdict | null>({ reducer: (_held, next) => next, default: () => null }),
  cloned: Annotation<number>({ reducer: (_held, next) => next, default: () => 0 }),
  done: Annotation<boolean>({ reducer: (_held, next) => next, default: () => false }),
});

export function buildAgentGraph(input: RunInput) {
  const guard = new RunGuard();

  const spent = (state: AgentState): AgentState =>
    parseState({
      ...state,
      budgets: { ...state.budgets, llm: input.router.budgetState() },
    });

  const clone = async (current: Carried): Promise<Partial<Carried>> => {
    if (current.state.filesRead.length > 0 || current.cloned > 0) {
      return {};
    }

    const result = await input.source.cloneInto(input.sandbox, input.reference);

    return {
      cloned: result.paths.length,
      state: parseState({
        ...current.state,
        sandboxId: input.sandbox.sandboxId,
        phase: 'clarifying',
      }),
    };
  };

  const scope = async (current: Carried): Promise<Partial<Carried>> => {
    const verdict = await validateScope(current.state, { router: input.router });

    if (verdict.outcome !== 'needs_clarification') {
      return { state: spent(withPhase(current.state, 'retrieving')) };
    }

    return {
      done: true,
      state: spent(
        parseState({
          ...current.state,
          phase: 'clarifying',
          clarificationQuestion: verdict.question,
        }),
      ),
    };
  };

  const retrieve = async (current: Carried): Promise<Partial<Carried>> => {
    const gathered = await gatherContext({
      state: current.state,
      source: input.sandbox,
      ...(input.images === undefined ? {} : { images: input.images }),
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    });

    return {
      context: gathered.context,
      state: parseState({
        ...withPhase(current.state, 'reasoning'),
        retrieved: gathered.retrieved.slice(0, 20),
      }),
    };
  };

  const reason = async (current: Carried): Promise<Partial<Carried>> => {
    const before = guard.beforeStep(current.state, Date.now(), input.signal?.aborted === true);

    if (before.stop) {
      return { done: true, verdict: before, state: stopWith(current.state, before) };
    }

    const chosen = await chooseNextAction({
      state: current.state,
      context: current.context,
      registry: input.registry,
      router: input.router,
      history: current.history.slice(-GRAPH_LIMITS.historyShown),
    });

    if (!chosen.accepted) {
      const refused = recordToolEvent(current.state, {
        step: current.state.budgets.steps,
        tool: 'message_user',
        outcome: 'refused',
        summary: (chosen.refusal ?? 'that action was refused').slice(
          0,
          GRAPH_LIMITS.refusalMaxChars,
        ),
        atMs: Date.now(),
      });

      return {
        state: spent(refused),
        history: [...current.history, `refused: ${chosen.refusal ?? ''}`],
      };
    }

    return {
      state: spent(
        parseState({
          ...current.state,
          proposedAction: {
            tool: chosen.action.tool,
            reason: chosen.action.intent,
            argumentsJson: JSON.stringify(chosen.action.toolArguments),
            actionHash: '0'.repeat(64),
          },
        }),
      ),
    };
  };

  const execute = async (current: Carried): Promise<Partial<Carried>> => {
    const proposed = current.state.proposedAction;

    if (proposed === null) {
      return {};
    }

    const result = await input.executor.execute({
      step: current.state.budgets.steps,
      toolCallId: `call_${String(current.state.budgets.steps)}`,
      tool: proposed.tool,
      toolArguments: JSON.parse(proposed.argumentsJson) as Record<string, unknown>,
      intent: proposed.reason,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const next = applyExecution(current.state, result);
    const after = guard.afterStep(result);
    const history = [
      ...current.history,
      repeatNotice(proposed.tool, result.observation.summary, guard.timesSeen(result.actionHash)),
    ];

    if (after.stop) {
      return { done: true, verdict: after, history, state: stopWith(next, after) };
    }

    if (result.status === 'approval_required') {
      return { done: true, history, state: next };
    }

    if (result.status === 'executed' && proposed.tool === 'prepare_commit') {
      return { history, state: withPhase(next, 'preparing_patch') };
    }
    return { history, state: next };
  };

  const complete = async (current: Carried): Promise<Partial<Carried>> => {
    const verdict = judgeCompletion(current.state);

    if (!verdict.finished) {
      return await Promise.resolve({
        state: withPhase(current.state, 'reasoning'),
        history: [...current.history, `not finished: ${verdict.reason}`],
      });
    }

    const prepared = await preparePatch({
      state: current.state,
      sandbox: input.sandbox,
      logger: input.logger,
    });

    if (!prepared.accepted) {
      return {
        done: true,
        patch: prepared,
        state: stopped(current.state, 'failed'),
        verdict: { stop: true, reason: 'failed', detail: 'the patch was refused by validation' },
      };
    }

    return { done: true, patch: prepared, state: stopped(current.state, 'completed') };
  };

  const afterScope = (current: Carried): string => (current.done ? END : 'retrieve');

  const afterReason = (current: Carried): string => {
    if (current.done) {
      return END;
    }
    return current.state.proposedAction === null ? 'reason' : 'execute';
  };

  const afterExecute = (current: Carried): string => {
    if (current.done) {
      return END;
    }
    return current.state.phase === 'preparing_patch' ? 'complete' : 'reason';
  };

  const afterComplete = (current: Carried): string => (current.done ? END : 'reason');

  const graph = new StateGraph(RunAnnotation)
    .addNode('clone', clone)
    .addNode('scope', scope)
    .addNode('retrieve', retrieve)
    .addNode('reason', reason)
    .addNode('execute', execute)
    .addNode('complete', complete)
    .addEdge(START, 'clone')
    .addEdge('clone', 'scope')
    .addConditionalEdges('scope', afterScope, [END, 'retrieve'])
    .addEdge('retrieve', 'reason')
    .addConditionalEdges('reason', afterReason, [END, 'reason', 'execute'])
    .addConditionalEdges('execute', afterExecute, [END, 'reason', 'complete'])
    .addConditionalEdges('complete', afterComplete, [END, 'reason']);

  return input.checkpointer === undefined
    ? graph.compile()
    : graph.compile({ checkpointer: input.checkpointer });
}
