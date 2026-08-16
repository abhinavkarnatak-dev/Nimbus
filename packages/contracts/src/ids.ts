import { z } from 'zod';

const ID_BODY = '[0-9A-Za-z_-]{21}';

const publicId = (prefix: string, label: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_${ID_BODY}$`), { error: `Invalid ${label}` });

export const UserIdSchema = publicId('usr', 'user id').brand<'UserId'>();
export const SessionIdSchema = publicId('ses', 'session id').brand<'SessionId'>();
export const InstallationRecordIdSchema = publicId(
  'ins',
  'installation record id',
).brand<'InstallationRecordId'>();
export const AttachmentIdSchema = publicId('att', 'attachment id').brand<'AttachmentId'>();
export const ApprovalIdSchema = publicId('apr', 'approval id').brand<'ApprovalId'>();
export const RequestIdSchema = publicId('req', 'request id').brand<'RequestId'>();
export const MessageIdSchema = publicId('msg', 'message id').brand<'MessageId'>();
export const IdempotencyKeySchema = publicId('idk', 'idempotency key').brand<'IdempotencyKey'>();

export const GitHubRepositoryIdSchema = z.int().positive().brand<'GitHubRepositoryId'>();
export const GitHubInstallationIdSchema = z.int().positive().brand<'GitHubInstallationId'>();

export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, { error: 'Invalid commit SHA' })
  .brand<'CommitSha'>();

export const ActionHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: 'Invalid action hash' })
  .brand<'ActionHash'>();

export const IsoTimestampSchema = z.iso.datetime({ offset: false });

export type UserId = z.infer<typeof UserIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type InstallationRecordId = z.infer<typeof InstallationRecordIdSchema>;
export type AttachmentId = z.infer<typeof AttachmentIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type GitHubRepositoryId = z.infer<typeof GitHubRepositoryIdSchema>;
export type GitHubInstallationId = z.infer<typeof GitHubInstallationIdSchema>;
export type CommitSha = z.infer<typeof CommitShaSchema>;
export type ActionHash = z.infer<typeof ActionHashSchema>;
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;
