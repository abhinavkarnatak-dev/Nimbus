import { createHash } from 'node:crypto';

import { ChangePlanSchema, type AgentState, type ChangePlan } from '@nimbus/contracts';

export function createChangePlan(state: AgentState): ChangePlan {
  const inspectPaths = [...new Set(state.retrieved.map((one) => one.path))].slice(0, 100);
  const likelyChangedPaths = state.taskSpec.requestedPaths.length > 0
    ? state.taskSpec.requestedPaths
    : inspectPaths.slice(0, 12);
  const material = JSON.stringify({
    objective: state.taskSpec.objective,
    revision: state.workspaceRevision,
    evidence: state.evidence.map((one) => one.evidenceId),
  });
  return ChangePlanSchema.parse({
    planId: `plan_${createHash('sha256').update(material).digest('base64url').slice(0, 20)}`,
    hypothesis: `The requested outcome can be achieved by changing only the repository areas supported by the retrieved evidence for: ${state.taskSpec.objective}`.slice(0, 2_000),
    inspectPaths,
    likelyChangedPaths,
    criterionIds: state.taskSpec.acceptanceCriteria.map((one) => one.criterionId),
    validationPlan: [
      'Run repository-defined checks for every affected package.',
      'Use a language-specific syntax or type fallback when a repository check is unavailable.',
      'Validate the final diff and run independent read-only review on the final revision.',
    ],
    risks: [
      'A repository-defined check may be unavailable in the sandbox.',
      'A changed contract may have consumers outside the initially retrieved files.',
    ],
    basedOnRevision: state.workspaceRevision,
    invalidatedByEvidenceId: null,
  });
}
