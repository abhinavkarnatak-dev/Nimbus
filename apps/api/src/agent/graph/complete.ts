import type { AgentState, CheckResult } from '@nimbus/contracts';

export const COMPLETION_REFUSALS = [
  'nothing_changed',
  'checks_failed',
  'checks_not_run',
  'criteria_unresolved',
  'blocking_ambiguity',
  'stale_checks',
  'review_missing',
  'review_rejected',
  'wrong_phase',
] as const;

export type CompletionRefusal = (typeof COMPLETION_REFUSALS)[number];

export interface CompletionVerdict {
  finished: boolean;
  refusal: CompletionRefusal | null;
  reason: string;
}

export function failingChecks(checks: readonly CheckResult[]): CheckResult[] {
  return checks.filter((check) => !['passed', 'skipped'].includes(check.status));
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
  if (state.taskSpec.blockingAmbiguity !== null) {
    return {
      finished: false,
      refusal: 'blocking_ambiguity',
      reason: state.taskSpec.blockingAmbiguity,
    };
  }

  const unresolved = state.taskSpec.acceptanceCriteria.filter(
    (criterion) => criterion.material && criterion.status !== 'satisfied',
  );
  if (unresolved.length > 0) {
    return {
      finished: false,
      refusal: 'criteria_unresolved',
      reason: `Unresolved acceptance criteria: ${unresolved.map((one) => one.criterionId).join(', ')}`,
    };
  }

  if (state.taskSpec.mode === 'informational') {
    const currentEvidence = state.evidence.some(
      (one) => one.current && one.revision.treeHash === state.workspaceRevision.treeHash,
    );
    return currentEvidence
      ? {
          finished: true,
          refusal: null,
          reason: 'the answer is supported by current repository evidence',
        }
      : {
          finished: false,
          refusal: 'criteria_unresolved',
          reason: 'the answer has no current repository evidence',
        };
  }

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

  const required = state.checks.filter((check) => check.required === true);
  if (required.some((check) => check.revision?.treeHash !== state.workspaceRevision.treeHash)) {
    return {
      finished: false,
      refusal: 'stale_checks',
      reason: 'At least one required check does not match the final workspace tree.',
    };
  }

  if (state.review === null) {
    return {
      finished: false,
      refusal: 'review_missing',
      reason: 'Independent review has not run.',
    };
  }
  if (state.review.revision.treeHash !== state.workspaceRevision.treeHash) {
    return { finished: false, refusal: 'review_missing', reason: 'Independent review is stale.' };
  }
  if (state.review.verdict !== 'accepted') {
    return { finished: false, refusal: 'review_rejected', reason: state.review.summary };
  }

  return {
    finished: true,
    refusal: null,
    reason: `${String(state.filesChanged.length)} files changed and every check passed`,
  };
}
