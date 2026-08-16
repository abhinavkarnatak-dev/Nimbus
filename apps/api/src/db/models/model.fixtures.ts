import { randomBytes } from 'node:crypto';

import { newPrefixedId } from '../../lib/id.js';
import type { GitHubInstallationDocument } from './github-installation.js';
import type { RepoIndexDocument } from './repo-index.js';
import type { SessionDocument } from './session.js';
import { daysFromNow } from './shared.js';
import type { UserDocument } from './user.js';

export function makeCommitSha(): string {
  return randomBytes(20).toString('hex');
}

export function makeEmail(): string {
  return `user-${randomBytes(5).toString('hex')}@example.com`;
}

export function makeUser(overrides: Partial<UserDocument> = {}): UserDocument {
  const now = new Date();
  return {
    userId: newPrefixedId('usr'),
    email: makeEmail(),
    displayName: 'Test User',
    authProviders: ['email_otp'],
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
    ...overrides,
  };
}

export function makeInstallation(
  userId: string,
  overrides: Partial<GitHubInstallationDocument> = {},
): GitHubInstallationDocument {
  const now = new Date();
  return {
    installationRecordId: newPrefixedId('ins'),
    userId,
    installationId: Math.floor(Math.random() * 90_000_000) + 10_000_000,
    accountId: Math.floor(Math.random() * 90_000_000) + 10_000_000,
    accountLogin: 'octocat',
    installedByGitHubUserId: 5_000_001,
    accountType: 'User',
    status: 'active',
    selectedRepositories: [{ repositoryId: 1_296_269, owner: 'octocat', name: 'hello-world' }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeSession(
  userId: string,
  overrides: Partial<SessionDocument> = {},
): SessionDocument {
  const now = new Date();
  return {
    sessionId: newPrefixedId('ses'),
    userId,
    status: 'queued',
    repository: {
      repositoryId: 1_296_269,
      owner: 'octocat',
      name: 'hello-world',
      defaultBranch: 'main',
      visibility: 'public',
      htmlUrl: 'https://github.com/octocat/hello-world',
      updatedAt: now,
    },
    branch: null,
    baseCommitSha: null,
    clarificationQuestion: null,
    clarificationAnswer: null,
    waitingSince: null,
    messages: [],
    task: 'Add a short setup section to the readme file',
    attachments: [],
    idempotencyKey: newPrefixedId('idk'),
    checkpointId: null,
    sandboxId: null,
    step: 0,
    maxSteps: 30,
    currentActivity: null,
    retryCount: 0,
    filesRead: [],
    filesChanged: [],
    checks: [],
    approvals: [],
    toolEvents: [],
    pullRequest: null,
    failure: null,
    lastEventSequence: 0,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    completedAt: null,
    ...overrides,
  };
}

export function makeRepoIndex(overrides: Partial<RepoIndexDocument> = {}): RepoIndexDocument {
  const now = new Date();
  return {
    repoIndexId: newPrefixedId('rpi'),
    repositoryId: 1_296_269,
    commitSha: makeCommitSha(),
    indexPolicyVersion: 1,
    embeddingModel: 'text-embedding-fake-1',
    qdrantCollection: 'nimbus_repo_1296269',
    qdrantTenant: 'repo_1296269',
    fileCount: 42,
    status: 'ready',
    indexedAt: now,
    createdAt: now,
    updatedAt: now,
    expiresAt: daysFromNow(30, now),
    ...overrides,
  };
}
