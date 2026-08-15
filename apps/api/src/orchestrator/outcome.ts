import type { AgentState, AgentStopReason, FailureCode, SessionFailure } from '@nimbus/contracts';

export const FAILURE_FOR_STOP: Readonly<Record<string, FailureCode>> = {
  step_budget: 'STEP_BUDGET_EXHAUSTED',
  retry_budget: 'STEP_BUDGET_EXHAUSTED',
  repeated_action: 'STEP_BUDGET_EXHAUSTED',
  token_budget: 'TOKEN_BUDGET_EXHAUSTED',
  time_budget: 'TIME_BUDGET_EXHAUSTED',
  failed: 'INTERNAL_ERROR',
};

export const FAILURE_MESSAGES: Readonly<Record<FailureCode, string>> = {
  TASK_TOO_BROAD: 'The task did not name anything specific enough to work on.',
  CLARIFICATION_TIMEOUT: 'Nobody answered the question in time.',
  APPROVAL_TIMEOUT: 'Nobody answered the approval request in time.',
  POLICY_DENIED: 'The change needed something Nimbus is never allowed to do.',
  STEP_BUDGET_EXHAUSTED: 'Nimbus used all of its steps without finishing the task.',
  TOKEN_BUDGET_EXHAUSTED: 'Nimbus used its whole model budget without finishing the task.',
  TIME_BUDGET_EXHAUSTED: 'Nimbus ran out of time before finishing the task.',
  SANDBOX_FAILED: 'The machine that runs the code could not be started.',
  CHECKS_FAILED: 'The project checks did not pass, so nothing was proposed.',
  PATCH_REJECTED: 'The change did not pass validation, so nothing was pushed.',
  PUSH_FAILED: 'The branch could not be pushed.',
  PULL_REQUEST_FAILED: 'The pull request could not be opened.',
  PROVIDER_UNAVAILABLE: 'A model provider could not be reached.',
  INTERNAL_ERROR: 'Something went wrong while running the task.',
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
