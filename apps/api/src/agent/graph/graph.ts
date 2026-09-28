import { createHash } from 'node:crypto';

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
import { EXECUTE_LIMITS } from '../execute/limits.js';
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
import { buildRepositoryProfile } from '../profile/repository-profile.js';
import { discoverSandboxCapabilities } from '../../sandbox/capabilities.js';
import { createChangePlan } from '../planning/plan.js';
import { currentWorkspaceRevision } from '../reliability/workspace.js';
import { plannedChecks } from '../verification/planner.js';
import { independentReview } from '../review/review.js';
import type { ActionReporter } from '../execute/reporter.js';

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
  reporter?: ActionReporter;
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

function fallbackCheckId(state: AgentState): string | null {
  const path = state.filesChanged.at(-1);
  if (path === undefined) return null;
  if (/\.tsx?$/i.test(path)) return `syntax:typescript:${path}`;
  if (/\.jsx?$/i.test(path)) return `syntax:javascript:${path}`;
  if (/\.py$/i.test(path)) return `syntax:python:${path}`;
  if (/\.c$/i.test(path)) return `syntax:c:${path}`;
  if (/\.(?:cc|cpp|cxx)$/i.test(path)) return `syntax:cpp:${path}`;
  if (/\.go$/i.test(path)) return `syntax:go:${path}`;
  if (/\.rs$/i.test(path)) return `syntax:rust:${path}`;
  if (/\.java$/i.test(path)) return `syntax:java:${path}`;
  if (/\.cs$/i.test(path)) return `syntax:csharp:${path}`;
  return null;
}

export function buildAgentGraph(input: RunInput) {
  const guard = new RunGuard();
  let lastPhase = '';
  let lastActivity: string | null = null;
  const announce = async (state: AgentState): Promise<void> => {
    if (state.phase === lastPhase && state.activity === lastActivity) return;
    lastPhase = state.phase;
    lastActivity = state.activity;
    await input.reporter?.phase?.(state.phase, state.activity, state.budgets.steps);
  };

  const spent = (state: AgentState): AgentState =>
    parseState({
      ...state,
      budgets: { ...state.budgets, llm: input.router.budgetState() },
    });

  const clone = async (current: Carried): Promise<Partial<Carried>> => {
    await announce(current.state);
    if (current.cloned > 0) {
      return {};
    }

    const result = await input.source.cloneInto(input.sandbox, input.reference);
    const repositoryProfile = await buildRepositoryProfile(
      input.sandbox,
      current.state.baseCommitSha,
    );
    const sandboxCapabilities = await discoverSandboxCapabilities(input.sandbox);
    const workspaceRevision = await currentWorkspaceRevision(
      input.sandbox,
      current.state.baseCommitSha,
      current.state.workspaceRevision.number,
    );

    return {
      cloned: result.paths.length,
      state: parseState({
        ...current.state,
        sandboxId: input.sandbox.sandboxId,
        phase: 'scoping',
        activity: 'Scoping the request against the cloned repository',
        repositoryProfile,
        sandboxCapabilities,
        workspaceRevision,
      }),
    };
  };

  const scope = async (current: Carried): Promise<Partial<Carried>> => {
    await announce(current.state);
    if (current.state.clarificationAnswer !== null) {
      return {
        state: spent(
          parseState({
            ...current.state,
            clarificationQuestion: null,
            phase: 'planning',
            activity: 'Building a typed plan from repository evidence',
          }),
        ),
      };
    }

    const verdict = await validateScope(current.state, {
      router: input.router,
      context: current.context,
    });

    if (verdict.outcome !== 'needs_clarification') {
      return {
        state: spent(
          parseState({
            ...current.state,
            phase: 'planning',
            activity: 'Building a typed plan from repository evidence',
          }),
        ),
      };
    }

    return {
      done: true,
      state: spent(
        parseState({
          ...current.state,
          phase: 'awaiting_clarification',
          clarificationQuestion: verdict.question,
        }),
      ),
    };
  };

  const retrieve = async (current: Carried): Promise<Partial<Carried>> => {
    await announce(current.state);
    const gathered = await gatherContext({
      state: current.state,
      source: input.sandbox,
      ...(input.images === undefined ? {} : { images: input.images }),
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    });

    return {
      context: gathered.context,
      state: parseState({
        ...withPhase(current.state, 'investigating'),
        retrieved: gathered.retrieved.slice(0, 20),
        activity: 'Inspecting repository structure and relevant code before deciding what to ask',
        evidence: [
          ...current.state.evidence,
          ...gathered.retrieved.slice(0, 20).map((file) => {
            const contentHash = createHash('sha256').update(file.snippet).digest('hex');
            return {
              evidenceId: `ev_${contentHash.slice(0, 24)}`,
              kind: 'file_content' as const,
              title: `${file.path}:${String(file.startLine)}-${String(file.endLine)}`,
              summary: 'Retrieved repository content relevant to the task.',
              paths: [file.path],
              revision: current.state.workspaceRevision,
              contentHash,
              createdAt: new Date().toISOString(),
              current: true,
            };
          }),
        ].slice(-300),
      }),
    };
  };

  const reason = async (current: Carried): Promise<Partial<Carried>> => {
    await announce(current.state);
    const before = guard.beforeStep(current.state, Date.now(), input.signal?.aborted === true);

    if (before.stop) {
      return { done: true, verdict: before, state: stopWith(current.state, before) };
    }

    if (current.state.taskSpec.mode === 'code_change' && current.state.plan === null) {
      return {
        state: withPhase(
          parseState({
            ...current.state,
            plan: createChangePlan(current.state),
            activity: 'Implementing the approved change plan',
          }),
          'implementing',
        ),
      };
    }

    if (
      current.state.taskSpec.mode === 'code_change' &&
      current.state.filesChanged.length > 0 &&
      !checkedSinceLastEdit(current.state)
    ) {
      const checkId =
        (current.state.repositoryProfile === null
          ? undefined
          : plannedChecks(current.state.repositoryProfile, current.state.filesChanged)[0]
              ?.checkId) ?? fallbackCheckId(current.state);

      if (checkId === null) {
        return {
          done: true,
          verdict: {
            stop: true,
            reason: 'failed',
            detail: 'no trusted verification fallback exists',
          },
          state: stopped(current.state, 'failed'),
        };
      }
      return {
        state: parseState({
          ...withPhase(current.state, 'verifying'),
          activity: 'Running trusted verification for the current revision',
          proposedAction: {
            tool: 'run_checks',
            reason: 'Running a trusted repository or language check for the current revision.',
            arguments: { checkId },
            actionHash: '0'.repeat(64),
          },
        }),
      };
    }

    if (
      current.state.taskSpec.mode === 'code_change' &&
      current.state.filesChanged.length > 0 &&
      checkedSinceLastEdit(current.state) &&
      current.state.checks.every(
        (check) => !['failed', 'errored', 'blocked', 'timed_out'].includes(check.status),
      )
    ) {
      const criterionEvidence = current.state.checks
        .map((check) => check.checkId)
        .filter((one): one is string => one !== undefined);
      return {
        state: parseState({
          ...withPhase(current.state, 'reviewing'),
          activity: 'Reviewing the final diff independently',
          taskSpec: {
            ...current.state.taskSpec,
            acceptanceCriteria: current.state.taskSpec.acceptanceCriteria.map((criterion) => ({
              ...criterion,
              status: 'satisfied' as const,
              evidenceIds: [...new Set([...criterion.evidenceIds, ...criterionEvidence])],
            })),
          },
        }),
      };
    }

    if (
      current.state.phase === 'verifying' &&
      current.state.checks.some((check) =>
        ['failed', 'errored', 'blocked', 'timed_out'].includes(check.status),
      )
    ) {
      return {
        state: parseState({
          ...withPhase(current.state, 'implementing'),
          activity: 'Diagnosing the classified verification failure',
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
      const blockedHash = actionFingerprint(chosen.action.tool, chosen.action.toolArguments);
      const blockedSeen = guard.blockRepeat(blockedHash);
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

      if (blockedSeen >= EXECUTE_LIMITS.sameActionFailuresMax) {
        const verdict: StopVerdict = {
          stop: true,
          reason: 'repeated_action',
          detail: `${chosen.action.tool} remained ineligible after ${String(blockedSeen)} attempts`,
        };
        return { done: true, verdict, state: stopWith(refused, verdict) };
      }

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
            arguments: chosen.action.toolArguments,
            actionHash: '0'.repeat(64),
          },
          activity: chosen.action.intent,
          phaseBudget: {
            ...current.state.phaseBudget,
            modelCalls: current.state.phaseBudget.modelCalls + 1,
          },
        }),
      ),
    };
  };

  const execute = async (current: Carried): Promise<Partial<Carried>> => {
    await announce(current.state);
    const proposed = current.state.proposedAction;

    if (proposed === null) {
      return {};
    }

    const toolArguments = proposed.arguments;
    const actionHash = actionFingerprint(proposed.tool, toolArguments);

    if (proposed.tool === 'run_checks' && checkedSinceLastEdit(current.state)) {
      return {
        history: [
          ...current.history,
          'Blocked before running: a check has already run since the last edit. Read and fix a failed check, or package the patch when the recorded check passed. Do not run another check without a new edit.',
        ],
        state: parseState({ ...current.state, proposedAction: null, phase: 'implementing' }),
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
          state: parseState({ ...current.state, proposedAction: null, phase: 'implementing' }),
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
          state: parseState({ ...current.state, proposedAction: null, phase: 'implementing' }),
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
        state: parseState({ ...current.state, proposedAction: null, phase: 'implementing' }),
      };
    }

    const result = await input.executor.execute({
      step: current.state.budgets.steps,
      toolCallId: `call_${String(current.state.budgets.steps)}`,
      tool: proposed.tool,
      toolArguments,
      intent: proposed.reason,
      state: current.state,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    let next = applyExecution(current.state, result);

    if (
      result.status === 'executed' &&
      result.event.outcome === 'ok' &&
      (proposed.tool === 'apply_patch' || proposed.tool === 'create_file')
    ) {
      const candidate = await currentWorkspaceRevision(
        input.sandbox,
        current.state.baseCommitSha,
        current.state.workspaceRevision.number + 1,
      );
      if (candidate.treeHash !== current.state.workspaceRevision.treeHash) {
        const evidenceId = `ev_${candidate.treeHash.slice(0, 24)}`;
        next = parseState({
          ...next,
          workspaceRevision: candidate,
          checks: next.checks,
          review: null,
          evidence: [
            ...next.evidence.map((one) => ({ ...one, current: false })),
            {
              evidenceId,
              kind: 'edit',
              title: `Workspace revision ${String(candidate.number)}`,
              summary: result.observation.summary,
              paths: result.paths,
              revision: candidate,
              contentHash: candidate.treeHash,
              createdAt: new Date().toISOString(),
              current: true,
            },
          ].slice(-300),
        });
      }
    } else if (
      result.status === 'executed' &&
      result.event.outcome === 'ok' &&
      result.paths.length > 0
    ) {
      const contentHash = createHash('sha256').update(result.observation.text).digest('hex');
      next = parseState({
        ...next,
        evidence: [
          ...next.evidence,
          {
            evidenceId: `ev_${contentHash.slice(0, 24)}`,
            kind: proposed.tool === 'read_file' ? 'file_content' : 'search',
            title: result.observation.summary || proposed.tool,
            summary: result.observation.summary,
            paths: result.paths,
            revision: next.workspaceRevision,
            contentHash,
            createdAt: new Date().toISOString(),
            current: true,
          },
        ].slice(-300),
      });
    }

    if (result.check !== null) {
      const checkHash = createHash('sha256').update(JSON.stringify(result.check)).digest('hex');
      next = parseState({
        ...next,
        evidence: [
          ...next.evidence,
          {
            evidenceId: `ev_${checkHash.slice(0, 24)}`,
            kind: 'check',
            title: result.check.name,
            summary: result.check.summary,
            paths: result.check.scope ?? [],
            revision: next.workspaceRevision,
            contentHash: checkHash,
            createdAt: new Date().toISOString(),
            current: true,
          },
        ].slice(-300),
      });
    }

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
      const completed = parseState({
        ...next,
        taskSpec: {
          ...next.taskSpec,
          acceptanceCriteria: next.taskSpec.acceptanceCriteria.map((criterion) => ({
            ...criterion,
            status: 'satisfied' as const,
            evidenceIds: next.evidence
              .filter((one) => one.current)
              .map((one) => one.evidenceId)
              .slice(-40),
          })),
        },
      });
      if (
        completed.filesChanged.length === 0 &&
        completed.filesRead.length > 0 &&
        completed.evidence.some(
          (evidence) =>
            evidence.current &&
            evidence.kind === 'file_content' &&
            evidence.revision.treeHash === completed.workspaceRevision.treeHash,
        )
      ) {
        return { done: true, history, state: stopped(completed, 'completed') };
      }
      const gate = judgeCompletion(completed);
      return gate.finished
        ? { done: true, history, state: stopped(completed, 'completed') }
        : {
            history: [...history, `Completion gate refused: ${gate.reason}`],
            state: parseState({ ...completed, proposedAction: null, phase: 'planning' }),
          };
    }

    if (after.stop) {
      return { done: true, verdict: after, history, state: stopWith(next, after) };
    }

    if (result.status === 'approval_required' || result.pause !== null) {
      return { done: true, history, state: next };
    }

    return { history, state: next };
  };

  const review = async (current: Carried): Promise<Partial<Carried>> => {
    await announce(current.state);
    const prepared = await preparePatch({
      state: current.state,
      sandbox: input.sandbox,
      logger: input.logger,
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    });
    const reviewResult = independentReview(current.state, prepared);
    const reviewed = parseState({ ...current.state, review: reviewResult });

    if (reviewResult.verdict !== 'accepted') {
      return {
        done: true,
        patch: prepared,
        state: stopped(reviewed, 'failed'),
        verdict: { stop: true, reason: 'failed', detail: reviewResult.summary },
      };
    }
    return {
      patch: prepared,
      state: parseState({
        ...withPhase(reviewed, 'packaging'),
        activity: 'Validating and packaging the reviewed patch',
      }),
    };
  };

  const complete = async (current: Carried): Promise<Partial<Carried>> => {
    await announce(current.state);
    const verdict = judgeCompletion(current.state);

    if (!verdict.finished) {
      return await Promise.resolve({
        state: stopped(current.state, 'failed'),
        done: true,
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

    return {
      done: true,
      patch: prepared,
      state: stopped(
        parseState({ ...current.state, deliveryStage: 'patch_validated' }),
        'completed',
      ),
    };
  };

  const afterScope = (current: Carried): string => (current.done ? END : 'reason');

  const afterReason = (current: Carried): string => {
    if (current.done) {
      return END;
    }
    if (current.state.phase === 'reviewing') return 'review';
    return current.state.proposedAction === null ? 'reason' : 'execute';
  };

  const afterExecute = (current: Carried): string => {
    if (current.done) {
      return END;
    }
    return 'reason';
  };

  const afterReview = (current: Carried): string => (current.done ? END : 'complete');

  const afterComplete = (current: Carried): string => (current.done ? END : 'reason');

  const graph = new StateGraph(RunAnnotation)
    .addNode('clone', clone)
    .addNode('scope', scope)
    .addNode('retrieve', retrieve)
    .addNode('reason', reason)
    .addNode('execute', execute)
    .addNode('review', review)
    .addNode('complete', complete)
    .addEdge(START, 'clone')
    .addEdge('clone', 'retrieve')
    .addEdge('retrieve', 'scope')
    .addConditionalEdges('scope', afterScope, [END, 'reason'])
    .addConditionalEdges('reason', afterReason, [END, 'reason', 'execute', 'review'])
    .addConditionalEdges('execute', afterExecute, [END, 'reason'])
    .addConditionalEdges('review', afterReview, [END, 'complete'])
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
