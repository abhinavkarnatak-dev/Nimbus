export const COLLECTIONS = {
  users: 'users',
  githubInstallations: 'github_installations',
  sessions: 'sessions',
  repoIndexes: 'repo_indexes',
  auditEvents: 'audit_events',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
