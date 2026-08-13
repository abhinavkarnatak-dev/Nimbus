import { attachmentModel } from './attachment.js';
import { auditEventModel } from './audit-event.js';
import { githubInstallationModel } from './github-installation.js';
import { repoIndexModel } from './repo-index.js';
import { sessionModel } from './session.js';
import type { ModelDefinition } from './shared.js';
import { userModel } from './user.js';

export * from './shared.js';
export * from './user.js';
export * from './github-installation.js';
export * from './session.js';
export * from './repo-index.js';
export * from './attachment.js';
export * from './audit-event.js';

export const ALL_MODELS: readonly ModelDefinition[] = [
  userModel,
  githubInstallationModel,
  sessionModel,
  repoIndexModel,
  attachmentModel,
  auditEventModel,
];
