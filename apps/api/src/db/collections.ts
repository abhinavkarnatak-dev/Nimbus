export const COLLECTIONS = {
  users: 'users',
  githubInstallations: 'github_installations',
  sessions: 'sessions',
  sessionEvents: 'session_events',
  attachments: 'attachments',
  repoIndexes: 'repo_indexes',
  auditEvents: 'audit_events',
  checkpoints: 'checkpoints',
  providerKeys: 'provider_keys',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
