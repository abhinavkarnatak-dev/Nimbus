import { describe, expect, it } from 'vitest';

import { fakeRepository } from './fake-directory.js';
import { LISTING_PERMISSIONS, TokenScopeError, assertListingScope } from './permissions.js';
import {
  MAX_REPOSITORIES,
  isPublicRepository,
  toRepositorySummaries,
  toRepositorySummary,
} from './repositories.js';

describe('deciding whether a repository is public', () => {
  it('accepts a plainly public repository', () => {
    expect(isPublicRepository(fakeRepository({ id: 1 }))).toBe(true);
  });

  it('refuses a private repository', () => {
    expect(isPublicRepository(fakeRepository({ id: 1, private: true }))).toBe(false);
  });

  it('refuses an internal repository even though it is not private', () => {
    expect(
      isPublicRepository(fakeRepository({ id: 1, private: false, visibility: 'internal' })),
    ).toBe(false);
  });

  it('refuses a payload that does not say either way', () => {
    expect(isPublicRepository({ id: 1, name: 'mystery' })).toBe(false);
  });
});

describe('turning a GitHub repository into the contract shape', () => {
  it('keeps the fields the contract asks for', () => {
    const summary = toRepositorySummary(
      fakeRepository({ id: 42, owner: 'octocat', name: 'hello', defaultBranch: 'trunk' }),
    );

    expect(summary).toEqual({
      repositoryId: 42,
      owner: 'octocat',
      name: 'hello',
      defaultBranch: 'trunk',
      visibility: 'public',
      htmlUrl: 'https://github.com/octocat/hello',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
  });

  it('drops a private repository', () => {
    expect(toRepositorySummary(fakeRepository({ id: 1, private: true }))).toBeNull();
  });

  it('drops a repository with no owner', () => {
    expect(toRepositorySummary({ id: 1, name: 'x', private: false, owner: null })).toBeNull();
  });

  it('drops a repository with no usable timestamp', () => {
    const payload = fakeRepository({ id: 1 });
    delete payload.updated_at;

    expect(toRepositorySummary(payload)).toBeNull();
  });

  it('falls back to the push time when there is no update time', () => {
    const payload = fakeRepository({ id: 1 });
    delete payload.updated_at;
    payload.pushed_at = '2026-01-01T00:00:00.000Z';

    expect(toRepositorySummary(payload)?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('drops a repository whose branch name could not be a branch', () => {
    expect(toRepositorySummary(fakeRepository({ id: 1, defaultBranch: 'has spaces' }))).toBeNull();
  });
});

describe('turning a whole list', () => {
  it('keeps only the public ones', () => {
    const summaries = toRepositorySummaries([
      fakeRepository({ id: 1, name: 'open' }),
      fakeRepository({ id: 2, name: 'closed', private: true }),
      fakeRepository({ id: 3, name: 'internal', visibility: 'internal' }),
    ]);

    expect(summaries.map((repo) => repo.name)).toEqual(['open']);
  });

  it('removes duplicates by repository id', () => {
    const summaries = toRepositorySummaries([
      fakeRepository({ id: 1, name: 'once' }),
      fakeRepository({ id: 1, name: 'again' }),
    ]);

    expect(summaries).toHaveLength(1);
  });

  it('puts the most recently updated first', () => {
    const summaries = toRepositorySummaries([
      fakeRepository({ id: 1, name: 'older', updatedAt: '2026-01-01T00:00:00.000Z' }),
      fakeRepository({ id: 2, name: 'newer', updatedAt: '2026-08-01T00:00:00.000Z' }),
    ]);

    expect(summaries.map((repo) => repo.name)).toEqual(['newer', 'older']);
  });

  it('never returns more than the contract allows', () => {
    const many = Array.from({ length: MAX_REPOSITORIES + 50 }, (_unused, index) =>
      fakeRepository({ id: index + 1 }),
    );

    expect(toRepositorySummaries(many)).toHaveLength(MAX_REPOSITORIES);
  });

  it('survives a list of nothing but rubbish', () => {
    expect(toRepositorySummaries([{}, { id: 'x' }, { id: 1, private: true }])).toEqual([]);
  });
});

describe('the listing token scope', () => {
  it('asks for metadata read and nothing else', () => {
    expect(LISTING_PERMISSIONS).toEqual({ metadata: 'read' });
  });

  it('cannot read file contents or write anything', () => {
    expect(LISTING_PERMISSIONS['contents']).toBeUndefined();
    expect(LISTING_PERMISSIONS['pull_requests']).toBeUndefined();
  });

  it('still insists on a real installation', () => {
    expect(() => {
      assertListingScope(0);
    }).toThrow(TokenScopeError);
    expect(() => {
      assertListingScope(-1);
    }).toThrow(TokenScopeError);
    expect(() => {
      assertListingScope(1.5);
    }).toThrow(TokenScopeError);
    expect(() => {
      assertListingScope(152_851_946);
    }).not.toThrow();
  });
});
