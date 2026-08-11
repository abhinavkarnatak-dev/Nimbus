import {
  GitHubAccountTypeSchema,
  InstallationStatusSchema,
  InstallationSummarySchema,
  LIMITS,
  type GitHubAccountType,
  type InstallationStatus,
  type InstallationSummary,
} from '@nimbus/contracts';
import type { Collection, Db } from 'mongodb';

import { COLLECTIONS } from '../collections.js';
import {
  OBJECT_ID_PROPERTY,
  publicIdPattern,
  toIsoTimestamp,
  type ModelDefinition,
} from './shared.js';

export const INSTALLATION_RECORD_ID_PREFIX = 'ins';

export interface SelectedRepository {
  repositoryId: number;
  owner: string;
  name: string;
}

export interface GitHubInstallationDocument {
  installationRecordId: string;
  userId: string;
  installationId: number;
  accountId: number;
  accountLogin: string;
  installedByGitHubUserId: number;
  accountType: GitHubAccountType;
  status: InstallationStatus;
  selectedRepositories: SelectedRepository[];
  createdAt: Date;
  updatedAt: Date;
  removedAt?: Date;
}

export function githubInstallationsCollection(db: Db): Collection<GitHubInstallationDocument> {
  return db.collection<GitHubInstallationDocument>(COLLECTIONS.githubInstallations);
}

export function toInstallationSummary(document: GitHubInstallationDocument): InstallationSummary {
  return InstallationSummarySchema.parse({
    installationRecordId: document.installationRecordId,
    installationId: document.installationId,
    accountLogin: document.accountLogin,
    accountType: document.accountType,
    status: document.status,
    connectedAt: toIsoTimestamp(document.createdAt),
  });
}

export const githubInstallationModel: ModelDefinition = {
  name: COLLECTIONS.githubInstallations,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'installationRecordId',
        'userId',
        'installationId',
        'accountId',
        'accountLogin',
        'installedByGitHubUserId',
        'accountType',
        'status',
        'selectedRepositories',
        'createdAt',
        'updatedAt',
      ],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        installationRecordId: {
          bsonType: 'string',
          pattern: publicIdPattern(INSTALLATION_RECORD_ID_PREFIX),
        },
        userId: { bsonType: 'string', pattern: publicIdPattern('usr') },
        installationId: { bsonType: 'number', minimum: 1 },
        accountId: { bsonType: 'number', minimum: 1 },
        installedByGitHubUserId: { bsonType: 'number', minimum: 1 },
        accountLogin: { bsonType: 'string', minLength: 1, maxLength: LIMITS.ownerNameMaxChars },
        accountType: { enum: [...GitHubAccountTypeSchema.options] },
        status: { enum: [...InstallationStatusSchema.options] },
        selectedRepositories: {
          bsonType: 'array',
          maxItems: 500,
          items: {
            bsonType: 'object',
            additionalProperties: false,
            required: ['repositoryId', 'owner', 'name'],
            properties: {
              repositoryId: { bsonType: 'number', minimum: 1 },
              owner: { bsonType: 'string', minLength: 1, maxLength: LIMITS.ownerNameMaxChars },
              name: { bsonType: 'string', minLength: 1, maxLength: LIMITS.repositoryNameMaxChars },
            },
          },
        },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        removedAt: { bsonType: 'date' },
      },
    },
  },
  indexes: [
    {
      key: { installationRecordId: 1 },
      name: 'installation_record_id_unique',
      unique: true,
    },
    { key: { installationId: 1 }, name: 'installation_github_id_unique', unique: true },
    { key: { userId: 1, status: 1 }, name: 'installation_user_status' },
  ],
};
