import type { AgentState, AgentStopReason, FailureCode, SessionFailure } from '@nimbus/contracts';

import { isLlmError, type LlmErrorCode } from '../llm/errors.js';

export const FAILURE_FOR_STOP: Readonly<Record<string, FailureCode>> = {
  step_budget: 'STEP_BUDGET_EXHAUSTED',
  retry_budget: 'AGENT_STUCK',
  repeated_action: 'AGENT_STUCK',
  token_budget: 'TOKEN_BUDGET_EXHAUSTED',
  time_budget: 'TIME_BUDGET_EXHAUSTED',
  failed: 'INTERNAL_ERROR',
};

export const FAILURE_MESSAGES: Readonly<Record<FailureCode, string>> = {
  TASK_TOO_BROAD: 'The task did not name anything specific enough to work on.',
  CLARIFICATION_TIMEOUT: 'Nobody answered the question in time.',
  APPROVAL_TIMEOUT: 'Nobody answered the approval request in time.',
  POLICY_DENIED: 'The change needed something Nimbus is never allowed to do.',
  AGENT_STUCK:
    'Nimbus kept repeating the same action without getting anywhere, so it stopped rather than burn the rest of the run.',
  STEP_BUDGET_EXHAUSTED: 'Nimbus used all of its steps without finishing the task.',
  TOKEN_BUDGET_EXHAUSTED: 'Nimbus used its whole model budget without finishing the task.',
  TIME_BUDGET_EXHAUSTED: 'Nimbus ran out of time before finishing the task.',
  SANDBOX_FAILED: 'The machine that runs the code could not be started.',
  REPOSITORY_EMPTY:
    'This repository has no commits yet. Create an initial commit on GitHub, then start this session again.',
  CHECKS_FAILED: 'The project checks did not pass, so nothing was proposed.',
  PATCH_REJECTED: 'The change did not pass validation, so nothing was pushed.',
  PUSH_FAILED: 'The branch could not be pushed.',
  PULL_REQUEST_FAILED: 'The pull request could not be opened.',
  PROVIDER_UNAVAILABLE: 'A model provider could not be reached.',
  MODEL_RATE_LIMITED:
    'Your model provider turned the request down for going over its own rate limit. Nothing is wrong with the task. Wait a minute, or pick a model with more headroom, and start it again.',
  MODEL_KEY_REJECTED:
    'Your model provider refused the API key saved for this account. Add it again in settings.',
  MODEL_ANSWER_UNUSABLE:
    'The model could not answer in the shape Nimbus needs, however many times it was asked. A more capable model usually gets through this.',
  INTERNAL_ERROR: 'Something went wrong while running the task.',
};

export const FAILURE_FOR_LLM: Readonly<Partial<Record<LlmErrorCode, FailureCode>>> = {
  LLM_RATE_LIMITED: 'MODEL_RATE_LIMITED',
  LLM_UNAUTHENTICATED: 'MODEL_KEY_REJECTED',
  LLM_NOT_CONFIGURED: 'MODEL_KEY_REJECTED',
  LLM_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  LLM_TIMED_OUT: 'PROVIDER_UNAVAILABLE',
  LLM_FAILED: 'PROVIDER_UNAVAILABLE',
  LLM_SCHEMA_REFUSED: 'MODEL_ANSWER_UNUSABLE',
  LLM_RESPONSE_MALFORMED: 'MODEL_ANSWER_UNUSABLE',
  LLM_TRUNCATED: 'MODEL_ANSWER_UNUSABLE',
  LLM_CONTENT_REFUSED: 'MODEL_ANSWER_UNUSABLE',
  LLM_BUDGET_EXCEEDED: 'TOKEN_BUDGET_EXHAUSTED',
};

export function failureOf(code: FailureCode): SessionFailure {
  return { code, message: FAILURE_MESSAGES[code] };
}

export function isPaused(state: AgentState): boolean {
  return state.phase === 'awaiting_approval' || state.phase === 'clarifying';
}

export function failureForStop(stopReason: AgentStopReason | null): SessionFailure {
  if (stopReason === null) {
    return failureOf('INTERNAL_ERROR');
  }
  return failureOf(FAILURE_FOR_STOP[stopReason] ?? 'INTERNAL_ERROR');
}

export function failureForThrown(thrown: unknown): SessionFailure | null {
  if (!isLlmError(thrown)) {
    return null;
  }

  const mapped = FAILURE_FOR_LLM[thrown.code];
  return mapped === undefined ? null : failureOf(mapped);
}

export function failureForRun(stopReason: AgentStopReason | null, thrown: unknown): SessionFailure {
  return failureForThrown(thrown) ?? failureForStop(stopReason);
}
