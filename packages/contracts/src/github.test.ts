import { describe, expect, it } from 'vitest';

import { BranchNameSchema, RepositoriesResponseSchema, RepositorySummarySchema } from './github.js';
import {
  repositoryFixture,
  VALID_INSTALLATION_RECORD_ID,
  VALID_TIMESTAMP,
} from './session.fixtures.js';

describe('repository summary', () => {
  it('accepts a public repository', () => {
    expect(RepositorySummarySchema.parse(repositoryFixture())).toEqual(repositoryFixture());
  });

  it('rejects a private repository, which V1 does not support', () => {
    expect(
      RepositorySummarySchema.safeParse({ ...repositoryFixture(), visibility: 'private' }).success,
    ).toBe(false);
  });

  it('rejects a non-positive or non-integer repository id', () => {
    for (const repositoryId of [0, -1, 1.5, '42']) {
      expect(
        RepositorySummarySchema.safeParse({ ...repositoryFixture(), repositoryId }).success,
      ).toBe(false);
    }
  });

  it('rejects owner and name values carrying path or shell characters', () => {
    for (const owner of ['../etc', 'octo cat', 'octo/cat', '-octocat', 'octocat-']) {
      expect(RepositorySummarySchema.safeParse({ ...repositoryFixture(), owner }).success).toBe(
        false,
      );
    }
    for (const name of ['hello world', 'hello/world', 'hello;rm -rf', '../..']) {
      expect(RepositorySummarySchema.safeParse({ ...repositoryFixture(), name }).success).toBe(
        false,
      );
    }
  });

  it('rejects a clone URL supplied in place of the html URL', () => {
    expect(
      RepositorySummarySchema.safeParse({ ...repositoryFixture(), htmlUrl: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('rejects unknown keys such as a client supplied installation id', () => {
    expect(
      RepositorySummarySchema.safeParse({ ...repositoryFixture(), installationId: 99 }).success,
    ).toBe(false);
  });
});

describe('branch names', () => {
  it('accepts ordinary and namespaced branch names', () => {
    for (const branch of ['main', 'develop', 'nimbus/abc123-fix-dates', 'release/2026.08']) {
      expect(BranchNameSchema.safeParse(branch).success).toBe(true);
    }
  });

  it('rejects names Git itself forbids or that enable traversal', () => {
    for (const branch of [
      '',
      '/leading',
      'trailing/',
      'double//slash',
      'dot..dot',
      'has space',
      'tilde~1',
      'caret^1',
      'colon:name',
      'question?',
      'star*',
      'bracket[1]',
      'back\\slash',
      'feature.lock',
    ]) {
      expect(BranchNameSchema.safeParse(branch).success).toBe(false);
    }
  });
});

describe('repositories response', () => {
  it('accepts a response with no installation connected', () => {
    expect(RepositoriesResponseSchema.parse({ installation: null, repositories: [] })).toEqual({
      installation: null,
      repositories: [],
    });
  });

  it('accepts an active installation with repositories', () => {
    const payload = {
      installation: {
        installationRecordId: VALID_INSTALLATION_RECORD_ID,
        installationId: 12_345,
        accountLogin: 'octocat',
        accountType: 'User' as const,
        status: 'active' as const,
        connectedAt: VALID_TIMESTAMP,
      },
      repositories: [repositoryFixture()],
    };
    expect(RepositoriesResponseSchema.parse(payload)).toEqual(payload);
  });

  it('rejects an unknown installation status', () => {
    expect(
      RepositoriesResponseSchema.safeParse({
        installation: {
          installationRecordId: VALID_INSTALLATION_RECORD_ID,
          installationId: 12_345,
          accountLogin: 'octocat',
          accountType: 'User',
          status: 'pending',
          connectedAt: VALID_TIMESTAMP,
        },
        repositories: [],
      }).success,
    ).toBe(false);
  });
});
