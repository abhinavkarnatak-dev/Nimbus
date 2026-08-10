import type { Collection, Db } from 'mongodb';

import { COLLECTIONS } from '../collections.js';
import {
  COMMIT_SHA_PATTERN,
  OBJECT_ID_PROPERTY,
  publicIdPattern,
  type ModelDefinition,
} from './shared.js';

export const REPO_INDEX_ID_PREFIX = 'rpi';

export const REPO_INDEX_STATUSES = ['building', 'ready', 'expired', 'deleted'] as const;

export type RepoIndexStatus = (typeof REPO_INDEX_STATUSES)[number];

export const REPO_INDEX_RETENTION_DAYS = 30;

export interface RepoIndexDocument {
  repoIndexId: string;
  repositoryId: number;
  commitSha: string;
  indexPolicyVersion: number;
  embeddingModel: string;
  qdrantCollection: string;
  qdrantTenant: string;
  fileCount: number;
  status: RepoIndexStatus;
  indexedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export function repoIndexesCollection(db: Db): Collection<RepoIndexDocument> {
  return db.collection<RepoIndexDocument>(COLLECTIONS.repoIndexes);
}

export interface RepoIndexIdentity {
  repositoryId: number;
  commitSha: string;
  indexPolicyVersion: number;
  embeddingModel: string;
}

export function repoIndexIdentityFilter(identity: RepoIndexIdentity): RepoIndexIdentity {
  return {
    repositoryId: identity.repositoryId,
    commitSha: identity.commitSha,
    indexPolicyVersion: identity.indexPolicyVersion,
    embeddingModel: identity.embeddingModel,
  };
}

export const repoIndexModel: ModelDefinition = {
  name: COLLECTIONS.repoIndexes,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'repoIndexId',
        'repositoryId',
        'commitSha',
        'indexPolicyVersion',
        'embeddingModel',
        'qdrantCollection',
        'qdrantTenant',
        'fileCount',
        'status',
        'indexedAt',
        'createdAt',
        'updatedAt',
        'expiresAt',
      ],
      properties: {
        _id: OBJECT_ID_PROPERTY,
        repoIndexId: { bsonType: 'string', pattern: publicIdPattern(REPO_INDEX_ID_PREFIX) },
        repositoryId: { bsonType: 'number', minimum: 1 },
        commitSha: { bsonType: 'string', pattern: COMMIT_SHA_PATTERN },
        indexPolicyVersion: { bsonType: 'number', minimum: 1 },
        embeddingModel: { bsonType: 'string', minLength: 1, maxLength: 120 },
        qdrantCollection: { bsonType: 'string', minLength: 1, maxLength: 200 },
        qdrantTenant: { bsonType: 'string', minLength: 1, maxLength: 200 },
        fileCount: { bsonType: 'number', minimum: 0, maximum: 1_000_000 },
        status: { enum: [...REPO_INDEX_STATUSES] },
        indexedAt: { bsonType: ['date', 'null'] },
        createdAt: { bsonType: 'date' },
        updatedAt: { bsonType: 'date' },
        expiresAt: { bsonType: 'date' },
      },
    },
  },
  indexes: [
    { key: { repoIndexId: 1 }, name: 'repo_index_id_unique', unique: true },
    {
      key: { repositoryId: 1, commitSha: 1, indexPolicyVersion: 1, embeddingModel: 1 },
      name: 'repo_index_identity_unique',
      unique: true,
    },
    { key: { status: 1, updatedAt: -1 }, name: 'repo_index_status_recent' },
    { key: { expiresAt: 1 }, name: 'repo_index_ttl', expireAfterSeconds: 0 },
  ],
};
