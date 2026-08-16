import {
  ApprovalEffectSchema,
  type ApprovalCategory,
  type ApprovalEffect,
  type ApprovalRecord,
  type PolicyDecision,
  type RiskLevel,
} from '@nimbus/contracts';

import type { Logger } from '../../logging/logger.js';
import { type ApprovalStore } from './approvals.js';
import { actionHash } from './hash.js';
import { POLICY_LIMITS } from './limits.js';
import { classifyAction } from './rules.js';

export const REFUSED_BY_PERSON =
  'a person was shown this exact action and refused it, so it is settled for this session';

export interface ProposedTool {
  tool: string;
  input: unknown;
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  actionHash: string;
  category: ApprovalCategory;
  risk: RiskLevel;
  reason: string;
  paths: string[];
  effect: ApprovalEffect | null;
  approval: ApprovalRecord | null;
  approvedByUser: boolean;
  decidedAtMs: number;
}

export interface PolicyOptions {
  approvals: ApprovalStore;
  logger: Logger;
  now?: () => number;
}

export class PolicyGate {
  private readonly approvals: ApprovalStore;

  private readonly logger: Logger;

  private readonly now: () => number;

  constructor(options: PolicyOptions) {
    this.approvals = options.approvals;
    this.logger = options.logger;
    this.now = options.now ?? ((): number => Date.now());
  }

  hashOf(action: ProposedTool): string {
    return actionHash(action.tool, action.input);
  }

  async authorize(action: ProposedTool): Promise<PolicyOutcome> {
    const hash = this.hashOf(action);
    const found = classifyAction(action.tool, action.input);
    const decidedAtMs = this.now();

    if (found.decision === 'allowed') {
      return this.record(action, {
        decision: 'allowed',
        actionHash: hash,
        category: found.category,
        risk: found.risk,
        reason: found.reason,
        paths: found.paths,
        effect: null,
        approval: null,
        approvedByUser: false,
        decidedAtMs,
      });
    }

    if (found.decision === 'denied') {
      return this.record(action, {
        decision: 'denied',
        actionHash: hash,
        category: found.category,
        risk: found.risk,
        reason: found.reason,
        paths: found.paths,
        effect: null,
        approval: null,
        approvedByUser: false,
        decidedAtMs,
      });
    }

    const effect = this.effectFor(action.tool, found);
    const refused = await this.approvals.findRefused(hash);

    if (refused !== null) {
      return this.record(action, {
        decision: 'denied',
        actionHash: hash,
        category: found.category,
        risk: found.risk,
        reason: REFUSED_BY_PERSON,
        paths: found.paths,
        effect,
        approval: refused,
        approvedByUser: false,
        decidedAtMs,
      });
    }

    const usable = await this.approvals.findUsable(hash);

    if (usable === null) {
      return this.record(action, {
        decision: 'approval_required',
        actionHash: hash,
        category: found.category,
        risk: found.risk,
        reason: found.reason,
        paths: found.paths,
        effect,
        approval: null,
        approvedByUser: false,
        decidedAtMs,
      });
    }

    await this.approvals.consume(usable.approvalId);

    return this.record(action, {
      decision: 'allowed',
      actionHash: hash,
      category: found.category,
      risk: found.risk,
      reason: 'a person approved this exact action',
      paths: found.paths,
      effect,
      approval: usable,
      approvedByUser: true,
      decidedAtMs,
    });
  }

  async requestApproval(action: ProposedTool): Promise<ApprovalRecord> {
    const hash = this.hashOf(action);
    const found = classifyAction(action.tool, action.input);

    return await this.approvals.request(hash, this.effectFor(action.tool, found));
  }

  private effectFor(tool: string, found: ReturnType<typeof classifyAction>): ApprovalEffect {
    return ApprovalEffectSchema.parse({
      category: found.category,
      summary: `${tool}: ${found.reason}`.slice(0, POLICY_LIMITS.reasonMaxChars),
      paths: found.paths.slice(0, POLICY_LIMITS.pathsPerEffectMax),
      reason: found.reason.slice(0, POLICY_LIMITS.reasonMaxChars),
      risk: found.risk,
      ...(found.commandCategory === undefined ? {} : { commandCategory: found.commandCategory }),
    });
  }

  private record(action: ProposedTool, outcome: PolicyOutcome): PolicyOutcome {
    this.logger.info(
      {
        tool: action.tool,
        decision: outcome.decision,
        category: outcome.category,
        risk: outcome.risk,
        actionHash: outcome.actionHash,
        approvedByUser: outcome.approvedByUser,
        paths: outcome.paths.length,
      },
      'a policy decision was made',
    );

    return outcome;
  }
}
