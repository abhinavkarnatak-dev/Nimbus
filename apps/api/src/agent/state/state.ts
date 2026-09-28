import { createHash } from 'node:crypto';

import {
  AGENT_STATE_VERSION,
  AgentStateSchema,
  MAX_CHECK_RESULTS,
  MAX_FILES_READ,
  MAX_TOOL_EVENTS,
  type AgentState,
  type AgentStopReason,
  type CheckResult,
  type ModelPlan,
  type ToolEventSummary,
  type AgentPhase,
  type TaskSpec,
} from '@nimbus/contracts';

import { AgentStateError } from './errors.js';
import { newBudgets, type NewBudgetOptions } from './budgets.js';
import { assertStorable } from './sanitize.js';

export interface NewStateInput {
  sessionId: string;
  userId: string;
  repositoryId: number;
  installationId: number;
  task: string;
  baseCommitSha: string;
  defaultBranch: string;
  models: ModelPlan;
  attachmentIds?: readonly string[];
  budgets?: NewBudgetOptions;
}

export function createState(input: NewStateInput): AgentState {
  const now = Date.now();
  const workspaceRevision = {
    number: 0,
    treeHash: createHash('sha256').update(input.baseCommitSha).digest('hex'),
  };

  return parseState({
    version: AGENT_STATE_VERSION,
    sessionId: input.sessionId,
    userId: input.userId,
    repositoryId: input.repositoryId,
    installationId: input.installationId,

    task: input.task,
    clarificationQuestion: null,
    clarificationAnswer: null,
    attachmentIds: [...(input.attachmentIds ?? [])],
    imageDescriptions: [],

    baseCommitSha: input.baseCommitSha,
    defaultBranch: input.defaultBranch,
    featureBranch: null,
    sandboxId: null,

    phase: 'scoping',
    activity: 'Defining the task and acceptance criteria',
    phaseBudget: phaseBudget(now),
    stopReason: null,
    budgets: newBudgets(input.budgets),
    models: input.models,

    retrieved: [],
    filesRead: [],
    filesChanged: [],

    proposedAction: null,
    policy: null,
    toolEvents: [],
    checks: [],
    taskSpec: taskSpecFor(input.task),
    plan: null,
    evidence: [],
    workspaceRevision,
    actions: [],
    review: null,
    deliveryStage: 'not_started',
    repositoryProfile: null,
    sandboxCapabilities: null,
    generation: 1,
  });
}

function phaseBudget(startedAtMs: number): AgentState['phaseBudget'] {
  return {
    modelCalls: 0,
    maxModelCalls: 12,
    toolCalls: 0,
    maxToolCalls: 30,
    retries: 0,
    maxRetries: 3,
    noProgressActions: 0,
    maxNoProgressActions: 4,
    startedAtMs,
    maxDurationMs: 15 * 60 * 1_000,
  };
}

function taskSpecFor(task: string): TaskSpec {
  const request = task.trim().replace(/^@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\s+/, '');
  const informational = /^(what|which|who|where|when|why|how|tell|explain|describe|show|read)\b/i.test(
    request,
  );

  return {
    mode: informational ? 'informational' : 'code_change',
    objective: task,
    acceptanceCriteria: [
      {
        criterionId: 'ac_primary',
        description: informational
          ? 'The answer is supported by current repository evidence.'
          : 'The requested repository change is implemented and verified.',
        verificationType: informational ? 'repository_evidence' : 'review',
        material: true,
        status: 'pending',
        evidenceIds: [],
      },
    ],
    constraints: [],
    requestedPaths: [],
    prohibitedEffects: [
      'Do not write to the default branch.',
      'Do not merge, approve, close, or force-push a pull request.',
      'Do not expose credentials or secrets.',
    ],
    blockingAmbiguity: null,
  };
}

export function parseState(value: unknown): AgentState {
  const parsed = AgentStateSchema.safeParse(upgradeLegacyState(value));

  if (!parsed.success) {
    throw new AgentStateError('STATE_INVALID', 'That agent state is not usable.', {
      detail: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.map(String).join('.') || 'root'}:${issue.code}`)
        .join(','),
    });
  }
  return parsed.data;
}

function upgradeLegacyState(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }

  const held = value as Record<string, unknown>;
  if (held['version'] !== 2) {
    return value;
  }

  const phaseMap: Readonly<Record<string, AgentPhase>> = {
    starting: 'scoping',
    clarifying: 'awaiting_clarification',
    retrieving: 'investigating',
    reasoning: 'planning',
    awaiting_approval: 'awaiting_approval',
    executing: 'implementing',
    validating: 'verifying',
    preparing_patch: 'packaging',
    finished: 'completed',
    failed: 'failed',
  };
  const task = typeof held['task'] === 'string' ? held['task'] : 'Continue the requested task.';
  const base = typeof held['baseCommitSha'] === 'string' ? held['baseCommitSha'] : '';
  const proposed = held['proposedAction'];
  let upgradedProposed: unknown = proposed;

  if (typeof proposed === 'object' && proposed !== null && !Array.isArray(proposed)) {
    const action = proposed as Record<string, unknown>;
    let args: Record<string, unknown> = {};
    if (typeof action['argumentsJson'] === 'string') {
      try {
        const decoded: unknown = JSON.parse(action['argumentsJson']);
        if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
          args = decoded as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
    }
    upgradedProposed = {
      tool: action['tool'],
      reason: action['reason'],
      arguments: args,
      actionHash: action['actionHash'],
    };
  }

  return {
    ...held,
    version: AGENT_STATE_VERSION,
    phase: phaseMap[String(held['phase'])] ?? 'failed',
    activity: null,
    phaseBudget: phaseBudget(Date.now()),
    proposedAction: upgradedProposed,
    taskSpec: taskSpecFor(task),
    plan: null,
    evidence: [],
    workspaceRevision: {
      number: 0,
      treeHash: createHash('sha256').update(base).digest('hex'),
    },
    actions: [],
    review: null,
    deliveryStage: 'not_started',
    repositoryProfile: null,
    sandboxCapabilities: null,
    generation: 1,
  };
}

export function serializeState(state: AgentState): string {
  return assertStorable(parseState(state));
}

export function deserializeState(serialized: string): AgentState {
  let raw: unknown;

  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    throw new AgentStateError('CHECKPOINT_CORRUPT', 'That checkpoint could not be read.', {
      cause: error,
    });
  }
  return parseState(raw);
}

export function withPhase(state: AgentState, phase: AgentState['phase']): AgentState {
  assertPhaseTransition(state.phase, phase);
  return parseState({
    ...state,
    phase,
    phaseBudget: phase === state.phase ? state.phaseBudget : phaseBudget(Date.now()),
  });
}

export function stopped(state: AgentState, reason: AgentStopReason): AgentState {
  return parseState({
    ...state,
    phase: reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed',
    stopReason: reason,
    proposedAction: null,
  });
}

export const PHASE_TRANSITIONS: Readonly<Record<AgentPhase, readonly AgentPhase[]>> = {
  scoping: ['investigating', 'awaiting_clarification', 'failed', 'cancelled'],
  investigating: ['planning', 'awaiting_clarification', 'completed', 'failed', 'cancelled'],
  planning: ['implementing', 'investigating', 'awaiting_clarification', 'completed', 'failed', 'cancelled'],
  implementing: ['verifying', 'investigating', 'awaiting_approval', 'awaiting_clarification', 'failed', 'cancelled'],
  verifying: ['implementing', 'reviewing', 'awaiting_clarification', 'failed', 'cancelled'],
  reviewing: ['implementing', 'packaging', 'awaiting_clarification', 'failed', 'cancelled'],
  packaging: ['completed', 'failed', 'cancelled'],
  awaiting_clarification: ['investigating', 'planning', 'implementing', 'failed', 'cancelled'],
  awaiting_approval: ['implementing', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertPhaseTransition(from: AgentPhase, to: AgentPhase): void {
  if (from === to || PHASE_TRANSITIONS[from].includes(to)) {
    return;
  }
  throw new AgentStateError('STATE_INVALID', 'That agent phase transition is not allowed.', {
    detail: `${from}->${to}`,
  });
}

function appendBounded<T>(held: readonly T[], next: T, max: number): T[] {
  const all = [...held, next];
  return all.length <= max ? all : all.slice(all.length - max);
}

export function recordToolEvent(state: AgentState, event: ToolEventSummary): AgentState {
  return parseState({
    ...state,
    toolEvents: appendBounded(state.toolEvents, event, MAX_TOOL_EVENTS),
  });
}

export function recordFileRead(state: AgentState, path: string): AgentState {
  if (state.filesRead.includes(path)) {
    return state;
  }

  return parseState({
    ...state,
    filesRead: appendBounded(state.filesRead, path, MAX_FILES_READ),
  });
}

export function recordCheck(state: AgentState, check: CheckResult): AgentState {
  const others = state.checks.filter((held) => held.name !== check.name);

  return parseState({
    ...state,
    checks: appendBounded(others, check, MAX_CHECK_RESULTS),
  });
}

export function recordFileChanged(state: AgentState, path: string): AgentState {
  if (state.filesChanged.includes(path)) {
    return state;
  }
  return parseState({ ...state, filesChanged: [...state.filesChanged, path] });
}
