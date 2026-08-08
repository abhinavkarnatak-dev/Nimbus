export const VALID_USER_ID = 'usr_0123456789abcdefghijk';
export const VALID_SESSION_ID = 'ses_0123456789abcdefghijk';
export const VALID_ATTACHMENT_ID = 'att_0123456789abcdefghijk';
export const VALID_APPROVAL_ID = 'apr_0123456789abcdefghijk';
export const VALID_REQUEST_ID = 'req_0123456789abcdefghijk';
export const VALID_IDEMPOTENCY_KEY = 'idk_0123456789abcdefghijk';
export const VALID_INSTALLATION_RECORD_ID = 'ins_0123456789abcdefghijk';
export const VALID_COMMIT_SHA = '9f2c1a7b3d4e5f60718293a4b5c6d7e8f9012345';
export const VALID_ACTION_HASH = 'a'.repeat(64);
export const VALID_TIMESTAMP = '2026-08-09T01:00:00.000Z';

export const repositoryFixture = () => ({
  repositoryId: 42_919_301,
  owner: 'octocat',
  name: 'hello-world',
  defaultBranch: 'main',
  visibility: 'public' as const,
  htmlUrl: 'https://github.com/octocat/hello-world',
  updatedAt: VALID_TIMESTAMP,
});

export const attachmentFixture = () => ({
  attachmentId: VALID_ATTACHMENT_ID,
  kind: 'image' as const,
  mimeType: 'image/png' as const,
  byteSize: 2048,
  originalName: 'screenshot.png',
  createdAt: VALID_TIMESTAMP,
});

export const approvalEffectFixture = () => ({
  category: 'dependency_change' as const,
  summary: 'Add the date-fns package to dependencies',
  paths: ['package.json'],
  reason: 'The task requires formatting relative dates',
  risk: 'medium' as const,
});

export const approvalRequestFixture = () => ({
  approvalId: VALID_APPROVAL_ID,
  actionHash: VALID_ACTION_HASH,
  effect: approvalEffectFixture(),
  requestedAt: VALID_TIMESTAMP,
  expiresAt: '2026-08-09T01:10:00.000Z',
});

export const approvalRecordFixture = () => ({
  approvalId: VALID_APPROVAL_ID,
  actionHash: VALID_ACTION_HASH,
  effect: approvalEffectFixture(),
  status: 'approved' as const,
  requestedAt: VALID_TIMESTAMP,
  expiresAt: '2026-08-09T01:10:00.000Z',
  decidedAt: '2026-08-09T01:02:00.000Z',
});

export const fileChangeFixture = () => ({
  path: 'src/utils/format-date.ts',
  changeKind: 'modified' as const,
  addedLines: 12,
  removedLines: 3,
});

export const checkResultFixture = () => ({
  name: 'vitest',
  kind: 'test' as const,
  status: 'passed' as const,
  summary: '18 tests passed',
  durationMs: 4210,
});

export const pullRequestFixture = () => ({
  number: 7,
  url: 'https://github.com/octocat/hello-world/pull/7',
  branch: 'nimbus/0123456789-format-dates',
  headSha: VALID_COMMIT_SHA,
  createdAt: VALID_TIMESTAMP,
});

export const sessionSummaryFixture = () => ({
  sessionId: VALID_SESSION_ID,
  status: 'working' as const,
  task: 'Format the invoice dates using the existing date helper',
  repository: repositoryFixture(),
  branch: 'nimbus/0123456789-format-dates',
  pullRequest: null,
  createdAt: VALID_TIMESTAMP,
  lastActivityAt: VALID_TIMESTAMP,
  completedAt: null,
});

export const sessionDetailFixture = () => ({
  ...sessionSummaryFixture(),
  baseCommitSha: VALID_COMMIT_SHA,
  attachments: [attachmentFixture()],
  progress: { step: 4, maxSteps: 30, currentActivity: 'Reading src/utils/format-date.ts' },
  filesChanged: [fileChangeFixture()],
  checks: [checkResultFixture()],
  approvals: [approvalRecordFixture()],
  failure: null,
});

export const toolInvocationFixture = () => ({
  toolCallId: 'call_01',
  tool: 'read_file' as const,
  summary: 'Read src/utils/format-date.ts',
  paths: ['src/utils/format-date.ts'],
  startedAt: VALID_TIMESTAMP,
});
