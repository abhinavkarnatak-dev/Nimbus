import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type {
  AgentState,
  DescribedImage,
  PatchValidationReport,
  SessionMessage,
} from '@nimbus/contracts';

import type { Logger } from '../../logging/logger.js';
import type { AttachedText } from '../../routing/context.js';
import type { SessionRouter } from '../../routing/router.js';
import type { Sandbox } from '../../sandbox/index.js';
import type { RepositoryReference, RepositorySource } from '../clone/index.js';
import { actionFingerprint, type ActionExecutor } from '../execute/executor.js';
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
import type { PatchCaps } from '../../config/limits.js';
import { judgeCompletion } from './complete.js';
import { GRAPH_LIMITS } from './limits.js';
import { preparePatch, type PreparedPatch } from './patch.js';

export interface ConversationSource {
  latest(): Promise<readonly SessionMessage[]>;
}

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
  conversation?: ConversationSource;
  reviewComments?: string;
  checkpointer?: BaseCheckpointSaver;
  limits?: PatchCaps;
  signal?: AbortSignal;
}

export interface RunResult {
  state: AgentState;
  patch: PreparedPatch | null;
  report: PatchValidationReport | null;
  stopVerdict: StopVerdict | null;
  cloned: number;
  steps: number;
  threw?: unknown;
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

function checkedSinceLastEdit(state: AgentState): boolean {
  let lastEdit = -1;
  let lastCheck = -1;

  state.toolEvents.forEach((event, index) => {
    if (event.tool === 'create_file' || event.tool === 'apply_patch') {
      lastEdit = index;
    }
    if (event.tool === 'run_checks') {
      lastCheck = index;
    }
  });

  return lastCheck > lastEdit;
}

function automaticExampleCheck(
  state: AgentState,
): { argv: string[]; name: string; kind: 'test' | 'typecheck' } | null {
  const last = state.toolEvents.at(-1);
  const path = state.filesChanged.at(-1);
  if (
    last === undefined ||
    !['create_file', 'apply_patch'].includes(last.tool) ||
    path === undefined ||
    checkedSinceLastEdit(state) ||
    !/\b(simple|basic|example)\b/i.test(state.task)
  )
    return null;

  if (/\.(?:c|cc|cpp|cxx)$/i.test(path)) {
    return {
      name: 'C++ syntax check',
      kind: 'test',
      argv: ['g++', '-std=c++17', '-fsyntax-only', path],
    };
  }
  if (/\.py$/i.test(path)) {
    return {
      name: 'Python syntax check',
      kind: 'typecheck',
      argv: ['python', '-B', '-m', 'py_compile', path],
    };
  }
  return null;
}

export function buildAgentGraph(input: RunInput) {
  const guard = new RunGuard();

  const spent = (state: AgentState): AgentState =>
    parseState({
      ...state,
      budgets: { ...state.budgets, llm: input.router.budgetState() },
    });

  const clone = async (current: Carried): Promise<Partial<Carried>> => {
    if (current.cloned > 0) {
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
    if (current.state.clarificationAnswer !== null) {
      return {
        state: spent(
          parseState({
            ...current.state,
            clarificationQuestion: null,
            phase: 'retrieving',
          }),
        ),
      };
    }

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

    const completion = judgeCompletion(current.state);

    if (completion.finished) {
      return {
        state: spent(
          parseState({
            ...current.state,
            proposedAction: {
              tool: 'prepare_commit',
              reason:
                'The requested files are changed and the recorded checks passed, so I am packaging the patch for review.',
              argumentsJson: JSON.stringify({ summary: current.state.task.slice(0, 400) }),
              actionHash: '0'.repeat(64),
            },
          }),
        ),
      };
    }

    const check = automaticExampleCheck(current.state);
    if (check !== null) {
      return {
        state: parseState({
          ...current.state,
          proposedAction: {
            tool: 'run_checks',
            reason:
              'The requested example was created. Running its syntax check before packaging the change.',
            argumentsJson: JSON.stringify(check),
            actionHash: '0'.repeat(64),
          },
        }),
      };
    }

    const chosen = await chooseNextAction({
      state: current.state,
      context: current.context,
      registry: input.registry,
      router: input.router,
      history: current.history.slice(-GRAPH_LIMITS.historyShown),
      conversation: await latestConversation(input),
      ...(input.reviewComments === undefined ? {} : { reviewComments: input.reviewComments }),
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

    const toolArguments = JSON.parse(proposed.argumentsJson) as Record<string, unknown>;
    const actionHash = actionFingerprint(proposed.tool, toolArguments);

    if (proposed.tool === 'run_checks' && checkedSinceLastEdit(current.state)) {
      return {
        history: [
          ...current.history,
          'Blocked before running: a check has already run since the last edit. Read and fix a failed check, or package the patch when the recorded check passed. Do not run another check without a new edit.',
        ],
        state: parseState({ ...current.state, proposedAction: null, phase: 'reasoning' }),
      };
    }

    if (proposed.tool === 'prepare_commit') {
      const completion = judgeCompletion(current.state);

      if (!completion.finished) {
        return {
          history: [
            ...current.history,
            `Blocked before running: prepare_commit is only allowed after the requested files are changed and every recorded check has passed. ${completion.reason}`,
          ],
          state: parseState({ ...current.state, proposedAction: null, phase: 'reasoning' }),
        };
      }
    }

    if (proposed.tool === 'finish_task' && current.state.filesChanged.length > 0) {
      const completion = judgeCompletion(current.state);
      if (!completion.finished) {
        return {
          history: [
            ...current.history,
            `Blocked before finishing: a changed repository cannot be reported as successful yet. ${completion.reason}`,
          ],
          state: parseState({ ...current.state, proposedAction: null, phase: 'reasoning' }),
        };
      }
    }

    if (guard.timesSeen(actionHash) > 0) {
      const blocked = guard.blockRepeat(actionHash);
      const history = [
        ...current.history,
        `Blocked before running: ${proposed.tool} with these exact arguments already completed. Do not repeat it unless you first make a new edit that makes another check necessary. Choose the next useful action.`,
      ];

      if (blocked >= 2) {
        return {
          done: true,
          history,
          state: stopped(parseState({ ...current.state, proposedAction: null }), 'repeated_action'),
        };
      }

      return {
        history,
        state: parseState({ ...current.state, proposedAction: null, phase: 'reasoning' }),
      };
    }

    const result = await input.executor.execute({
      step: current.state.budgets.steps,
      toolCallId: `call_${String(current.state.budgets.steps)}`,
      tool: proposed.tool,
      toolArguments,
      intent: proposed.reason,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    let next = applyExecution(current.state, result);

    if (result.pause === 'clarification' && result.userMessage !== null) {
      next = parseState({ ...next, clarificationQuestion: result.userMessage });
    }
    const after = guard.afterStep(result);
    const repeated = guard.timesSeen(result.actionHash);
    const history = [
      ...current.history,
      [
        result.observation.text,
        repeated > 1 ? repeatNotice(proposed.tool, result.observation.summary, repeated) : '',
      ]
        .filter((entry) => entry !== '')
        .join('\n\n'),
    ];

    if (result.status === 'executed' && proposed.tool === 'finish_task') {
      return { done: true, history, state: stopped(next, 'completed') };
    }

    if (after.stop) {
      return { done: true, verdict: after, history, state: stopWith(next, after) };
    }

    if (result.status === 'approval_required' || result.pause !== null) {
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
      ...(input.limits === undefined ? {} : { limits: input.limits }),
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

export async function latestConversation(input: RunInput): Promise<readonly SessionMessage[]> {
  const source = input.conversation;

  if (source === undefined) {
    return [];
  }

  try {
    return await source.latest();
  } catch (error) {
    input.logger.warn(
      { sessionId: input.state.sessionId, error: String(error) },
      'what the person has said could not be read, this step goes on without it',
    );
    return [];
  }
}
