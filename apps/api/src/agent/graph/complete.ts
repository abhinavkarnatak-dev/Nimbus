import type { AgentState, CheckResult } from '@nimbus/contracts';

export const COMPLETION_REFUSALS = ['nothing_changed', 'checks_failed', 'checks_not_run'] as const;

export type CompletionRefusal = (typeof COMPLETION_REFUSALS)[number];

export interface CompletionVerdict {
  finished: boolean;
  refusal: CompletionRefusal | null;
  reason: string;
}

export function failingChecks(checks: readonly CheckResult[]): CheckResult[] {
  return checks.filter((check) => check.status === 'failed' || check.status === 'errored');
}

function hasCheckSinceLastEdit(state: AgentState): boolean {
  if (state.toolEvents.length === 0) {
    return state.checks.length > 0;
  }

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

export function judgeCompletion(state: AgentState): CompletionVerdict {
  if (state.filesChanged.length === 0) {
    return {
      finished: false,
      refusal: 'nothing_changed',
      reason:
        'No file has been changed, so there is nothing to hand over. Make the change the task asks for, or say why it should not be made.',
    };
  }

  if (!hasCheckSinceLastEdit(state)) {
    return {
      finished: false,
      refusal: 'checks_not_run',
      reason:
        'The checks have not been run. Call run_checks so the change can be handed over with evidence that it works.',
    };
  }

  const failing = failingChecks(state.checks);

  if (failing.length > 0) {
    return {
      finished: false,
      refusal: 'checks_failed',
      reason: `These checks did not pass: ${failing
        .map((check) => `${check.name} (${check.status})`)
        .join(', ')}. Fix what they report, then run them again.`,
    };
  }

  return {
    finished: true,
    refusal: null,
    reason: `${String(state.filesChanged.length)} files changed and every check passed`,
  };
}
