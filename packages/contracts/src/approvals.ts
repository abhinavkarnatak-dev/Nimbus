import { z } from 'zod';

import { ActionHashSchema, ApprovalIdSchema, IsoTimestampSchema } from './ids.js';
import { LIMITS } from './limits.js';
import { WorkspacePathSchema } from './tools.js';

export const PolicyDecisionSchema = z.enum(['allowed', 'approval_required', 'denied']);

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);

export const APPROVAL_CATEGORIES = [
  'dependency_change',
  'lifecycle_scripts',
  'protected_path_change',
  'file_deletion',
  'file_rename',
  'oversized_diff',
  'network_access',
  'uncategorized_action',
] as const;

export const ApprovalCategorySchema = z.enum(APPROVAL_CATEGORIES);

export const ApprovalEffectSchema = z.strictObject({
  category: ApprovalCategorySchema,
  summary: z.string().min(1).max(LIMITS.summaryMaxChars),
  paths: z.array(WorkspacePathSchema).max(LIMITS.approvalPathsMax),
  commandCategory: z.string().min(1).max(120).optional(),
  reason: z.string().min(1).max(LIMITS.reasonMaxChars),
  risk: RiskLevelSchema,
});

export const ApprovalRequestSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  actionHash: ActionHashSchema,
  effect: ApprovalEffectSchema,
  requestedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
});

export const ApprovalDecisionSchema = z.enum(['approved', 'rejected']);

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const ApprovalDecisionBodySchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  actionHash: ActionHashSchema,
  decision: ApprovalDecisionSchema,
});

export const ApprovalRecordSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  actionHash: ActionHashSchema,
  effect: ApprovalEffectSchema,
  status: ApprovalStatusSchema,
  requestedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  decidedAt: IsoTimestampSchema.optional(),
});

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type ApprovalCategory = z.infer<typeof ApprovalCategorySchema>;
export type ApprovalEffect = z.infer<typeof ApprovalEffectSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionBodySchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
