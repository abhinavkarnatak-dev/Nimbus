import { createHmac } from 'node:crypto';

import {
  createTestDatabase,
  createTestRedis,
  type TestDatabase,
  type TestRedis,
} from '@nimbus/test-utils';
import type { AuthenticatedUser } from '@nimbus/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { findOrCreateUserByEmail } from '../../src/auth/user-repository.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { auditEventsCollection } from '../../src/db/models/audit-event.js';
import {
  githubInstallationsCollection,
  type GitHubInstallationDocument,
} from '../../src/db/models/github-installation.js';
import { usersCollection } from '../../src/db/models/user.js';
import { FakeGitHubDirectory } from '../../src/github/fake-directory.js';
import { FakeGitHubTokenProvider } from '../../src/github/fake-token-provider.js';
import { InstallationService } from '../../src/github/installation-service.js';
import { GitHubWebhookService, type WebhookResult } from '../../src/github/webhook-service.js';
import { ApiError } from '../../src/http/api-error.js';
import { createTestLogger, testConfig } from '../../src/http/http.fixtures.js';

const INSTALLATION_ID = 152_879_739;
const OTHER_INSTALLATION_ID = 900_000_222;
const IP = '203.0.113.10';
const INSTALL_CODE = 'github-install-code';
const SECRET = 'a-long-random-webhook-secret-value';

let db: TestDatabase;
let redis: TestRedis;
let directory: FakeGitHubDirectory;
let installations: InstallationService;
let webhooks: GitHubWebhookService;
let deliveryCounter = 0;
let logger: ReturnType<typeof createTestLogger>['logger'];
let logged: ReturnType<typeof createTestLogger>['lines'];

const GITHUB_CONFIG = {
  appId: '123456',
  appSlug: 'nimbus-test',
  clientId: 'Iv23liFakeClientId',
  clientSecret: 'fake-client-secret',
  privateKeyPem: 'unused-by-the-fake',
  webhookSecret: SECRET,
  setupCallbackUrl: 'http://localhost:4000/github/setup/callback',
};

function nextDeliveryId(): string {
  deliveryCounter += 1;
  return `e1b0c2d4-0000-4000-8000-${String(deliveryCounter).padStart(12, '0')}`;
}

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function deliver(
  event: string,
  payload: unknown,
  overrides: { deliveryId?: string; signature?: string; body?: Buffer } = {},
): Promise<WebhookResult> {
  const body = overrides.body ?? Buffer.from(JSON.stringify(payload), 'utf8');

  return webhooks.handle({
    event,
    deliveryId: overrides.deliveryId ?? nextDeliveryId(),
    signature: overrides.signature ?? sign(body),
    body,
    ip: IP,
  });
}

async function makeUser(email: string): Promise<AuthenticatedUser> {
  const { user } = await findOrCreateUserByEmail(db.db, email, 'email_otp');
  return user;
}

async function connectFor(
  user: AuthenticatedUser,
  installationId = INSTALLATION_ID,
): Promise<void> {
  directory.knowsInstallation(installationId);
  directory.knowsInstaller(INSTALL_CODE, {
    githubUserId: 5_000_001,
    reachableInstallationIds: [installationId],
  });
  const started = await installations.beginConnect(user.userId);

  await installations.completeSetup({
    userId: user.userId,
    installationId,
    state: started.state,
    code: INSTALL_CODE,
    ip: IP,
  });
}

async function record(
  installationId = INSTALLATION_ID,
): Promise<GitHubInstallationDocument | null> {
  return githubInstallationsCollection(db.db).findOne({ installationId });
}

async function apiErrorFrom(action: Promise<unknown>): Promise<ApiError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the delivery to be refused');
}

function repository(id: number, name: string, isPrivate = false): Record<string, unknown> {
  return { id, name, full_name: `octocat/${name}`, private: isPrivate };
}

beforeAll(async () => {
  db = await createTestDatabase('nimbus_webhook');
  redis = await createTestRedis();
  await ensureDatabaseSchema(db.db);
  void testConfig();
});

afterAll(async () => {
  await redis.cleanup();
  await db.cleanup();
});

beforeEach(async () => {
  await redis.client.flushdb();
  await usersCollection(db.db).deleteMany({});
  await githubInstallationsCollection(db.db).deleteMany({});
  await auditEventsCollection(db.db).deleteMany({});

  const captured = createTestLogger();
  logger = captured.logger;
  logged = captured.lines;
  directory = new FakeGitHubDirectory();

  installations = new InstallationService({
    redis: redis.client,
    db: db.db,
    tokens: new FakeGitHubTokenProvider(),
    directory,
    github: GITHUB_CONFIG,
    logger,
  });
  webhooks = new GitHubWebhookService({
    redis: redis.client,
    db: db.db,
    github: GITHUB_CONFIG,
    logger,
  });
});

describe('proving a delivery came from GitHub', () => {
  it('refuses a delivery carrying no signature', async () => {
    const error = await apiErrorFrom(
      deliver('installation', { action: 'suspend' }, { signature: '' }),
    );

    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.status).toBe(401);
  });

  it('refuses a delivery signed with the wrong secret', async () => {
    const body = Buffer.from(JSON.stringify({ action: 'suspend' }), 'utf8');

    const error = await apiErrorFrom(
      deliver('installation', undefined, { body, signature: sign(body, 'not-the-secret') }),
    );

    expect(error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a body changed after it was signed', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    const honest = Buffer.from(
      JSON.stringify({ action: 'suspend', installation: { id: INSTALLATION_ID } }),
      'utf8',
    );
    const tampered = Buffer.from(
      JSON.stringify({ action: 'deleted', installation: { id: INSTALLATION_ID } }),
      'utf8',
    );

    const error = await apiErrorFrom(
      deliver('installation', undefined, { body: tampered, signature: sign(honest) }),
    );

    expect(error.code).toBe('UNAUTHENTICATED');
    expect((await record())?.status).toBe('active');
  });

  it('checks the signature before it looks at anything else', async () => {
    const error = await apiErrorFrom(
      deliver('installation', undefined, {
        body: Buffer.from('not json at all', 'utf8'),
        signature: '',
        deliveryId: 'not a valid delivery id',
      }),
    );

    expect(error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a malformed delivery id rather than throwing on a redis key', async () => {
    const error = await apiErrorFrom(
      deliver(
        'installation',
        { action: 'suspend', installation: { id: INSTALLATION_ID } },
        { deliveryId: 'has:reserved*characters' },
      ),
    );

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.status).toBe(400);
  });

  it('refuses a signed body that is not json', async () => {
    const body = Buffer.from('not json at all', 'utf8');

    const error = await apiErrorFrom(deliver('installation', undefined, { body }));

    expect(error.code).toBe('VALIDATION_FAILED');
  });
});

describe('applying installation lifecycle events', () => {
  it('suspends a connected installation', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    const result = await deliver('installation', {
      action: 'suspend',
      installation: { id: INSTALLATION_ID },
    });

    expect(result.outcome).toBe('applied');
    expect((await record())?.status).toBe('suspended');
  });

  it('makes a suspended installation stop being usable', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation', { action: 'suspend', installation: { id: INSTALLATION_ID } });

    expect(await installations.activeInstallation(user.userId)).toBeNull();
    await expect(installations.listRepositories(user.userId)).rejects.toThrow(ApiError);
  });

  it('brings a suspended installation back', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation', { action: 'suspend', installation: { id: INSTALLATION_ID } });
    await deliver('installation', { action: 'unsuspend', installation: { id: INSTALLATION_ID } });

    expect((await record())?.status).toBe('active');
    expect(await installations.activeInstallation(user.userId)).not.toBeNull();
  });

  it('marks an uninstalled installation removed and stamps when', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation', { action: 'deleted', installation: { id: INSTALLATION_ID } });

    const saved = await record();
    expect(saved?.status).toBe('removed');
    expect(saved?.removedAt).toBeInstanceOf(Date);
  });

  it('keeps the record after an uninstall rather than deleting the history', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation', { action: 'deleted', installation: { id: INSTALLATION_ID } });

    const saved = await record();
    expect(saved?.userId).toBe(user.userId);
    expect(saved?.installedByGitHubUserId).toBe(5_000_001);
  });

  it('never revives a removed installation from a late event', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation', { action: 'deleted', installation: { id: INSTALLATION_ID } });
    const result = await deliver('installation', {
      action: 'unsuspend',
      installation: { id: INSTALLATION_ID },
    });

    expect(result).toEqual({ outcome: 'ignored', reason: 'installation_already_removed' });
    expect((await record())?.status).toBe('removed');
  });

  it('touches an installation when new permissions are accepted', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    const before = await record();

    const result = await deliver('installation', {
      action: 'new_permissions_accepted',
      installation: { id: INSTALLATION_ID },
    });

    expect(result.outcome).toBe('applied');
    const after = await record();
    expect(after?.status).toBe('active');
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);
  });
});

describe('what a webhook is not allowed to do', () => {
  it('never creates an installation record', async () => {
    const result = await deliver('installation', {
      action: 'created',
      installation: { id: INSTALLATION_ID },
      repositories: [repository(1, 'anything')],
    });

    expect(result).toEqual({
      outcome: 'ignored',
      reason: 'installation_created_needs_a_signed_in_owner',
    });
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(0);
  });

  it('acknowledges an installation Nimbus does not hold instead of failing', async () => {
    const result = await deliver('installation', {
      action: 'suspend',
      installation: { id: OTHER_INSTALLATION_ID },
    });

    expect(result).toEqual({ outcome: 'ignored', reason: 'unknown_installation' });
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(0);
  });

  it('never touches an installation belonging to a different number', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation', {
      action: 'deleted',
      installation: { id: OTHER_INSTALLATION_ID },
    });

    expect((await record())?.status).toBe('active');
  });

  it('never changes who owns an installation or the proven github identity', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    const before = await record();

    await deliver('installation', {
      action: 'suspend',
      installation: { id: INSTALLATION_ID, account: { id: 9_999, login: 'attacker' } },
    });

    const after = await record();
    expect(after?.userId).toBe(before?.userId);
    expect(after?.installedByGitHubUserId).toBe(before?.installedByGitHubUserId);
    expect(after?.accountLogin).toBe(before?.accountLogin);
  });

  it('ignores events it does not handle', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    for (const event of ['push', 'pull_request', 'ping', 'check_run']) {
      const result = await deliver(event, {
        action: 'anything',
        installation: { id: INSTALLATION_ID },
      });

      expect(result).toEqual({ outcome: 'ignored', reason: 'unhandled_event' });
    }
    expect((await record())?.status).toBe('active');
  });
});

describe('repository changes', () => {
  it('stores repositories that were added', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation_repositories', {
      action: 'added',
      installation: { id: INSTALLATION_ID },
      repository_selection: 'selected',
      repositories_added: [repository(11, 'one'), repository(12, 'two')],
    });

    expect((await record())?.selectedRepositories).toEqual([
      { repositoryId: 11, owner: 'octocat', name: 'one' },
      { repositoryId: 12, owner: 'octocat', name: 'two' },
    ]);
  });

  it('keeps a private repository out of what gets stored', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation_repositories', {
      action: 'added',
      installation: { id: INSTALLATION_ID },
      repository_selection: 'selected',
      repositories_added: [repository(11, 'one'), repository(12, 'secret', true)],
    });

    expect((await record())?.selectedRepositories).toEqual([
      { repositoryId: 11, owner: 'octocat', name: 'one' },
    ]);
  });

  it('drops repositories that were removed', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation_repositories', {
      action: 'added',
      installation: { id: INSTALLATION_ID },
      repository_selection: 'selected',
      repositories_added: [repository(11, 'one'), repository(12, 'two')],
    });
    await deliver('installation_repositories', {
      action: 'removed',
      installation: { id: INSTALLATION_ID },
      repository_selection: 'selected',
      repositories_removed: [repository(11, 'one')],
    });

    expect((await record())?.selectedRepositories).toEqual([
      { repositoryId: 12, owner: 'octocat', name: 'two' },
    ]);
  });

  it('stores nothing when the installation covers every repository', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    const result = await deliver('installation_repositories', {
      action: 'added',
      installation: { id: INSTALLATION_ID },
      repository_selection: 'all',
      repositories_added: [repository(11, 'one')],
    });

    expect(result.reason).toBe('selects_all');
    expect((await record())?.selectedRepositories).toEqual([]);
  });

  it('writes a list the database validator accepts', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation_repositories', {
      action: 'added',
      installation: { id: INSTALLATION_ID },
      repository_selection: 'selected',
      repositories_added: Array.from({ length: 600 }, (_, index) =>
        repository(index + 1, `repo-${String(index)}`),
      ),
    });

    expect((await record())?.selectedRepositories).toHaveLength(500);
  });
});

describe('the same delivery arriving twice', () => {
  it('does the work once and acknowledges the repeat', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    const deliveryId = nextDeliveryId();
    const payload = { action: 'suspend', installation: { id: INSTALLATION_ID } };

    const first = await deliver('installation', payload, { deliveryId });
    const second = await deliver('installation', payload, { deliveryId });

    expect(first.outcome).toBe('applied');
    expect(second).toEqual({ outcome: 'duplicate', reason: 'status_suspended' });
  });

  it('audits the change once, not twice', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    const deliveryId = nextDeliveryId();
    const payload = { action: 'suspend', installation: { id: INSTALLATION_ID } };

    await deliver('installation', payload, { deliveryId });
    await deliver('installation', payload, { deliveryId });

    const events = await auditEventsCollection(db.db)
      .find({ action: 'github.installation.suspended' })
      .toArray();

    expect(events).toHaveLength(1);
  });

  it('treats a different delivery of the same change as new work', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    const payload = { action: 'suspend', installation: { id: INSTALLATION_ID } };

    const first = await deliver('installation', payload);
    const second = await deliver('installation', payload);

    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('applied');
    expect((await record())?.status).toBe('suspended');
  });

  it('lets GitHub retry after handling failed partway', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    const deliveryId = nextDeliveryId();
    const payload = { action: 'suspend', installation: { id: INSTALLATION_ID } };

    const broken = new GitHubWebhookService({
      redis: redis.client,
      db: {
        collection: () => ({ findOne: () => Promise.reject(new Error('mongo is down')) }),
      } as never,
      github: GITHUB_CONFIG,
      logger: createTestLogger().logger,
    });
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    await expect(
      broken.handle({ event: 'installation', deliveryId, signature: sign(body), body, ip: IP }),
    ).rejects.toThrow('mongo is down');

    const retried = await deliver('installation', payload, { deliveryId });

    expect(retried.outcome).toBe('applied');
    expect((await record())?.status).toBe('suspended');
  });

  it('does not claim a delivery it was never going to act on', async () => {
    const deliveryId = nextDeliveryId();
    const payload = { action: 'created', installation: { id: INSTALLATION_ID } };

    await deliver('installation', payload, { deliveryId });

    expect(await redis.client.exists(`nimbus:idem:${deliveryId}`)).toBe(0);
  });
});

describe('the audit trail', () => {
  it('records lifecycle changes as coming from a webhook, not a person', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation', { action: 'suspend', installation: { id: INSTALLATION_ID } });

    const event = await auditEventsCollection(db.db).findOne({
      action: 'github.installation.suspended',
    });

    expect(event?.actorType).toBe('webhook');
    expect(event?.userId).toBe(user.userId);
    expect(event?.installationRecordId).toBe((await record())?.installationRecordId);
  });

  it('records a repository change with what moved', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation_repositories', {
      action: 'added',
      installation: { id: INSTALLATION_ID },
      repository_selection: 'selected',
      repositories_added: [repository(11, 'one')],
    });

    const event = await auditEventsCollection(db.db).findOne({
      action: 'github.repositories.changed',
    });

    expect(event?.metadata).toMatchObject({ added: 1, removed: 0, stored: 1 });
  });

  it('writes nothing for an installation Nimbus does not hold', async () => {
    await deliver('installation', {
      action: 'suspend',
      installation: { id: OTHER_INSTALLATION_ID },
    });

    expect(await auditEventsCollection(db.db).countDocuments({})).toBe(0);
  });

  it('writes nothing for a refused signature so the log cannot be flooded', async () => {
    await apiErrorFrom(deliver('installation', { action: 'suspend' }, { signature: '' }));

    expect(await auditEventsCollection(db.db).countDocuments({})).toBe(0);
  });
});

describe('being able to trace a change back to a github delivery', () => {
  it('names the delivery in the log when a lifecycle change is applied', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    const deliveryId = nextDeliveryId();

    await deliver(
      'installation',
      { action: 'suspend', installation: { id: INSTALLATION_ID } },
      { deliveryId },
    );

    const line = logged.find(
      (entry) => entry.msg === 'Applied a GitHub installation lifecycle event',
    );
    expect(line?.['deliveryId']).toBe(deliveryId);
  });

  it('names the delivery in the log when repositories change', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    const deliveryId = nextDeliveryId();

    await deliver(
      'installation_repositories',
      {
        action: 'added',
        installation: { id: INSTALLATION_ID },
        repository_selection: 'selected',
        repositories_added: [repository(11, 'one')],
      },
      { deliveryId },
    );

    const line = logged.find(
      (entry) => entry.msg === 'Updated the repositories stored for an installation',
    );
    expect(line?.['deliveryId']).toBe(deliveryId);
  });

  it('never writes the signature or the secret into the log', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    await deliver('installation', { action: 'suspend', installation: { id: INSTALLATION_ID } });
    await apiErrorFrom(
      deliver(
        'installation',
        { action: 'suspend', installation: { id: INSTALLATION_ID } },
        { signature: `sha256=${'a'.repeat(64)}` },
      ),
    );

    const text = JSON.stringify(logged);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('sha256=');
  });
});
