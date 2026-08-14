import {
  AGENT_STATE_VERSION,
  AgentStateSchema,
  MAX_FILES_READ,
  MAX_TOOL_EVENTS,
  type AgentState,
  type AgentStopReason,
  type ModelPlan,
  type ToolEventSummary,
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

    phase: 'starting',
    stopReason: null,
    budgets: newBudgets(input.budgets),
    models: input.models,

    retrieved: [],
    filesRead: [],
    filesChanged: [],

    proposedAction: null,
    policy: null,
    toolEvents: [],
  });
}

export function parseState(value: unknown): AgentState {
  const parsed = AgentStateSchema.safeParse(value);

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
  return parseState({ ...state, phase });
}

export function stopped(state: AgentState, reason: AgentStopReason): AgentState {
  return parseState({
    ...state,
    phase: reason === 'completed' ? 'finished' : 'failed',
    stopReason: reason,
    proposedAction: null,
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

export function recordFileChanged(state: AgentState, path: string): AgentState {
  if (state.filesChanged.includes(path)) {
    return state;
  }
  return parseState({ ...state, filesChanged: [...state.filesChanged, path] });
}
