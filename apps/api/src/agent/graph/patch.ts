import type { AgentState, PatchValidationReport } from '@nimbus/contracts';

import { DEFAULT_LIMITS, type PatchCaps } from '../../config/limits.js';
import type { Logger } from '../../logging/logger.js';
import { validatePatch } from '../../patch/validator.js';
import type { Sandbox } from '../../sandbox/index.js';

export interface PreparedPatch {
  patch: string;
  report: PatchValidationReport;
  accepted: boolean;
  summary: string;
}

export interface PreparePatchInput {
  state: AgentState;
  sandbox: Sandbox;
  logger: Logger;
  limits?: PatchCaps;
}

export async function preparePatch(input: PreparePatchInput): Promise<PreparedPatch> {
  const exported = await input.sandbox.exportPatch();

  const report = validatePatch({
    patch: exported.patch,
    expectedBaseSha: input.state.baseCommitSha,
    reportedBaseSha: input.state.baseCommitSha,
    limits: input.limits ?? DEFAULT_LIMITS,
  });

  const accepted = report.decision !== 'denied';

  input.logger.info(
    {
      sessionId: input.state.sessionId,
      decision: report.decision,
      changedFiles: report.changedFiles,
      addedLines: report.addedLines,
      removedLines: report.removedLines,
      bytes: report.bytes,
      findings: report.findings.map((finding) => finding.code),
      approvals: report.approvals.length,
    },
    'a patch was prepared for review',
  );

  return {
    patch: exported.patch,
    report,
    accepted,
    summary: `${String(report.changedFiles)} files, +${String(report.addedLines)} -${String(report.removedLines)}, ${report.decision}`,
  };
}
