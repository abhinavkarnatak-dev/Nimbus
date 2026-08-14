export const COLLECTIONS = {
  users: 'users',
  githubInstallations: 'github_installations',
  sessions: 'sessions',
  attachments: 'attachments',
  repoIndexes: 'repo_indexes',
  auditEvents: 'audit_events',
  checkpoints: 'checkpoints',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
