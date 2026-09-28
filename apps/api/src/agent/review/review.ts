import { PatchReviewSchema, type AgentState, type PatchReview } from '@nimbus/contracts';

import type { PreparedPatch } from '../graph/patch.js';

export function independentReview(state: AgentState, prepared: PreparedPatch): PatchReview {
  const findings: string[] = [];
  if (!prepared.accepted) findings.push('Deterministic patch validation did not accept the patch.');
  if (prepared.report.findings.length > 0) {
    findings.push(...prepared.report.findings.map((one) => `${one.code}: ${one.detail}`));
  }
  if (state.taskSpec.acceptanceCriteria.some((one) => one.material && one.status !== 'satisfied')) {
    findings.push('One or more material acceptance criteria are unresolved.');
  }
  const required = state.checks.filter((one) => one.required === true);
  if (required.some((one) => one.revision?.treeHash !== state.workspaceRevision.treeHash)) {
    findings.push('At least one required check is stale for the final tree.');
  }
  if (required.some((one) => ['failed', 'errored', 'blocked', 'timed_out'].includes(one.status))) {
    findings.push('At least one required check has an unresolved failure.');
  }
  const verdict = findings.length === 0 ? 'accepted' : 'revision_requested';
  return PatchReviewSchema.parse({
    verdict,
    summary:
      verdict === 'accepted'
        ? 'The final diff is within policy, current checks support it, and no prohibited effect was found.'
        : 'The patch needs revision before it can be packaged.',
    findings,
    evidenceIds: state.evidence
      .filter((one) => one.current)
      .map((one) => one.evidenceId)
      .slice(-40),
    revision: state.workspaceRevision,
    reviewedAt: new Date().toISOString(),
  });
}
