import { describe, expect, it } from 'vitest';

import { mergeSelectedRepositories } from './webhook-service.js';
import {
  decideWebhookIntent,
  parseWebhookBody,
  toRemovedRepositoryIds,
  toSelectedRepositories,
  toSelectedRepository,
} from './webhook-events.js';

const INSTALLATION_ID = 152_879_739;

function repository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1_232_400_459,
    name: 'Python-Revision',
    full_name: 'abhinavkarnatak-dev/Python-Revision',
    private: false,
    ...overrides,
  };
}

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

describe('reading a webhook body', () => {
  it('reads a plain object', () => {
    expect(parseWebhookBody(body({ action: 'suspend' }))).toEqual({ action: 'suspend' });
  });

  it('refuses an empty body', () => {
    expect(parseWebhookBody(Buffer.alloc(0))).toBeNull();
  });

  it('refuses broken json rather than throwing', () => {
    expect(() => parseWebhookBody(Buffer.from('{"action":', 'utf8'))).not.toThrow();
    expect(parseWebhookBody(Buffer.from('{"action":', 'utf8'))).toBeNull();
  });

  it('refuses a top level array or scalar', () => {
    expect(parseWebhookBody(body([1, 2]))).toBeNull();
    expect(parseWebhookBody(body('suspend'))).toBeNull();
    expect(parseWebhookBody(body(null))).toBeNull();
  });
});

describe('turning a webhook repository into a stored one', () => {
  it('keeps a public repository and takes the owner from the full name', () => {
    expect(toSelectedRepository(repository())).toEqual({
      repositoryId: 1_232_400_459,
      owner: 'abhinavkarnatak-dev',
      name: 'Python-Revision',
    });
  });

  it('refuses a private repository', () => {
    expect(toSelectedRepository(repository({ private: true }))).toBeNull();
  });

  it('refuses a repository that does not say whether it is private', () => {
    expect(toSelectedRepository(repository({ private: undefined }))).toBeNull();
    expect(toSelectedRepository(repository({ private: 'false' }))).toBeNull();
  });

  it('refuses a full name that is not owner and repository', () => {
    for (const fullName of ['', 'noslash', '/leading', 123, null]) {
      expect(toSelectedRepository(repository({ full_name: fullName }))).toBeNull();
    }
  });

  it('refuses an owner or name the database would reject', () => {
    expect(toSelectedRepository(repository({ full_name: 'has space/repo' }))).toBeNull();
    expect(toSelectedRepository(repository({ name: 'has space' }))).toBeNull();
    expect(toSelectedRepository(repository({ name: '' }))).toBeNull();
  });

  it('refuses a bad repository id', () => {
    for (const id of [0, -1, 1.5, '123', null, undefined]) {
      expect(toSelectedRepository(repository({ id }))).toBeNull();
    }
  });

  it('drops what it cannot use and keeps the rest', () => {
    const selected = toSelectedRepositories([
      repository(),
      repository({ id: 2, name: 'Secret', full_name: 'me/Secret', private: true }),
      repository({ id: 3, name: 'Other', full_name: 'me/Other' }),
      repository(),
    ]);

    expect(selected.map((entry) => entry.repositoryId)).toEqual([1_232_400_459, 3]);
  });
});

describe('reading removed repository ids', () => {
  it('keeps the ids and ignores the rest of the payload', () => {
    expect(toRemovedRepositoryIds([repository({ id: 7 }), repository({ id: 9 })])).toEqual([7, 9]);
  });

  it('keeps a private repository id so it can still be removed', () => {
    expect(toRemovedRepositoryIds([repository({ id: 7, private: true })])).toEqual([7]);
  });

  it('drops unusable ids and repeats', () => {
    expect(toRemovedRepositoryIds([repository({ id: 7 }), repository({ id: 7 })])).toEqual([7]);
    expect(toRemovedRepositoryIds([repository({ id: 'seven' })])).toEqual([]);
  });
});

describe('deciding what a webhook means', () => {
  it('maps suspend, unsuspend and deleted onto a status', () => {
    const cases = [
      ['suspend', 'suspended'],
      ['unsuspend', 'active'],
      ['deleted', 'removed'],
    ] as const;

    for (const [action, status] of cases) {
      expect(
        decideWebhookIntent('installation', { action, installation: { id: INSTALLATION_ID } }),
      ).toEqual({ kind: 'status', installationId: INSTALLATION_ID, status });
    }
  });

  it('never creates anything from an installation created event', () => {
    const intent = decideWebhookIntent('installation', {
      action: 'created',
      installation: { id: INSTALLATION_ID },
      repositories: [repository()],
    });

    expect(intent).toEqual({
      kind: 'ignore',
      reason: 'installation_created_needs_a_signed_in_owner',
    });
  });

  it('treats accepted permissions as a touch', () => {
    expect(
      decideWebhookIntent('installation', {
        action: 'new_permissions_accepted',
        installation: { id: INSTALLATION_ID },
      }),
    ).toEqual({ kind: 'touch', installationId: INSTALLATION_ID });
  });

  it('ignores an installation action it does not handle', () => {
    expect(
      decideWebhookIntent('installation', {
        action: 'invented',
        installation: { id: INSTALLATION_ID },
      }),
    ).toEqual({ kind: 'ignore', reason: 'unhandled_installation_action' });
  });

  it('ignores an event it does not handle', () => {
    for (const event of ['push', 'pull_request', 'ping', '']) {
      expect(decideWebhookIntent(event, { action: 'suspend' })).toEqual({
        kind: 'ignore',
        reason: 'unhandled_event',
      });
    }
  });

  it('ignores a payload with no readable installation id', () => {
    for (const installation of [undefined, null, {}, { id: 0 }, { id: '152879739' }]) {
      expect(decideWebhookIntent('installation', { action: 'suspend', installation })).toEqual({
        kind: 'ignore',
        reason: 'unreadable_installation_payload',
      });
    }
  });

  it('reads repositories added and removed', () => {
    expect(
      decideWebhookIntent('installation_repositories', {
        action: 'added',
        installation: { id: INSTALLATION_ID },
        repository_selection: 'selected',
        repositories_added: [repository()],
        repositories_removed: [repository({ id: 42 })],
      }),
    ).toEqual({
      kind: 'repositories',
      installationId: INSTALLATION_ID,
      added: [
        { repositoryId: 1_232_400_459, owner: 'abhinavkarnatak-dev', name: 'Python-Revision' },
      ],
      removed: [42],
      selectsAll: false,
    });
  });

  it('keeps a private repository out of what gets stored', () => {
    const intent = decideWebhookIntent('installation_repositories', {
      action: 'added',
      installation: { id: INSTALLATION_ID },
      repositories_added: [repository({ id: 5, full_name: 'me/Secret', private: true })],
    });

    expect(intent).toMatchObject({ kind: 'repositories', added: [] });
  });

  it('notices when the installation covers every repository', () => {
    expect(
      decideWebhookIntent('installation_repositories', {
        action: 'added',
        installation: { id: INSTALLATION_ID },
        repository_selection: 'all',
      }),
    ).toMatchObject({ selectsAll: true, added: [], removed: [] });
  });

  it('falls back to the selection recorded on the installation', () => {
    expect(
      decideWebhookIntent('installation_repositories', {
        action: 'added',
        installation: { id: INSTALLATION_ID, repository_selection: 'all' },
      }),
    ).toMatchObject({ selectsAll: true });
  });

  it('ignores a repositories action it does not handle', () => {
    expect(
      decideWebhookIntent('installation_repositories', {
        action: 'invented',
        installation: { id: INSTALLATION_ID },
      }),
    ).toEqual({ kind: 'ignore', reason: 'unhandled_repositories_action' });
  });
});

describe('merging a stored repository list', () => {
  const stored = [
    { repositoryId: 1, owner: 'me', name: 'one' },
    { repositoryId: 2, owner: 'me', name: 'two' },
  ];

  it('adds without duplicating', () => {
    expect(
      mergeSelectedRepositories(stored, [{ repositoryId: 1, owner: 'me', name: 'one' }], []),
    ).toEqual(stored);
  });

  it('removes by id', () => {
    expect(mergeSelectedRepositories(stored, [], [1])).toEqual([
      { repositoryId: 2, owner: 'me', name: 'two' },
    ]);
  });

  it('lets a removal win over an addition in the same delivery', () => {
    expect(
      mergeSelectedRepositories(stored, [{ repositoryId: 3, owner: 'me', name: 'three' }], [3]),
    ).toEqual(stored);
  });

  it('never grows past what the database accepts', () => {
    const many = Array.from({ length: 600 }, (_, index) => ({
      repositoryId: index + 1,
      owner: 'me',
      name: `repo-${String(index)}`,
    }));

    expect(mergeSelectedRepositories([], many, [])).toHaveLength(500);
  });
});
