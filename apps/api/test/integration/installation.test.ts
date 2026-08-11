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
import { githubInstallationsCollection } from '../../src/db/models/github-installation.js';
import { usersCollection } from '../../src/db/models/user.js';
import { FakeGitHubDirectory, fakeRepository } from '../../src/github/fake-directory.js';
import { FakeGitHubTokenProvider } from '../../src/github/fake-token-provider.js';
import { InstallationService } from '../../src/github/installation-service.js';
import { ApiError } from '../../src/http/api-error.js';
import { createTestLogger, testConfig } from '../../src/http/http.fixtures.js';

const INSTALLATION_ID = 152_851_946;
const OTHER_INSTALLATION_ID = 900_000_111;
const IP = '203.0.113.10';
const INSTALL_CODE = 'github-install-code';

let db: TestDatabase;
let redis: TestRedis;
let directory: FakeGitHubDirectory;
let tokens: FakeGitHubTokenProvider;
let service: InstallationService;

const GITHUB_CONFIG = {
  appId: '123456',
  appSlug: 'nimbus-test',
  clientId: 'Iv23liFakeClientId',
  clientSecret: 'fake-client-secret',
  privateKeyPem: 'unused-by-the-fake',
  webhookSecret: 'webhook-secret',
  setupCallbackUrl: 'http://localhost:4000/github/setup/callback',
};

function build(): InstallationService {
  const { logger } = createTestLogger();
  directory = new FakeGitHubDirectory();
  tokens = new FakeGitHubTokenProvider();

  return new InstallationService({
    redis: redis.client,
    db: db.db,
    tokens,
    directory,
    github: GITHUB_CONFIG,
    logger,
  });
}

async function makeUser(email: string): Promise<AuthenticatedUser> {
  const { user } = await findOrCreateUserByEmail(db.db, email, 'email_otp');
  return user;
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
  throw new Error('Expected the action to be refused');
}

async function connectFor(user: AuthenticatedUser, installationId = INSTALLATION_ID) {
  directory.knowsInstallation(installationId);
  directory.knowsInstaller(INSTALL_CODE, {
    githubUserId: 5_000_001,
    reachableInstallationIds: [installationId],
  });
  const started = await service.beginConnect(user.userId);

  return service.completeSetup({
    userId: user.userId,
    installationId,
    state: started.state,
    code: INSTALL_CODE,
    ip: IP,
  });
}

beforeAll(async () => {
  db = await createTestDatabase('nimbus_install');
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
  service = build();
});

describe('starting a connection', () => {
  it('sends the browser to GitHub to prove who they are, carrying a one time value', async () => {
    const user = await makeUser('a@example.com');

    const started = await service.beginConnect(user.userId);
    const url = new URL(started.redirectUrl);

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('state')).toBe(started.state);
    expect(url.searchParams.get('client_id')).toBe('Iv23liFakeClientId');
  });

  it('never puts the client secret in the browser', async () => {
    const user = await makeUser('a@example.com');

    const started = await service.beginConnect(user.userId);

    expect(started.redirectUrl).not.toContain('fake-client-secret');
  });

  it('still knows where to send somebody who has not installed the app', () => {
    expect(service.installUrl()).toBe('https://github.com/apps/nimbus-test/installations/new');
  });

  it('gives a different value every time', async () => {
    const user = await makeUser('a@example.com');

    const first = await service.beginConnect(user.userId);
    const second = await service.beginConnect(user.userId);

    expect(first.state).not.toBe(second.state);
  });
});

describe('finishing a connection', () => {
  it('remembers the installation against the account', async () => {
    const user = await makeUser('a@example.com');

    const summary = await connectFor(user);

    expect(summary.installationId).toBe(INSTALLATION_ID);
    expect(summary.status).toBe('active');
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(1);
  });

  it('checks with GitHub rather than believing the number in the url', async () => {
    const user = await makeUser('a@example.com');

    await connectFor(user);

    expect(directory.installationLookups).toContain(INSTALLATION_ID);
  });

  it('records a suspended installation as suspended', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID, { suspended: true });
    directory.knowsInstaller(INSTALL_CODE, {
      githubUserId: 5_000_001,
      reachableInstallationIds: [INSTALLATION_ID],
    });
    const started = await service.beginConnect(user.userId);

    const summary = await service.completeSetup({
      userId: user.userId,
      installationId: INSTALLATION_ID,
      state: started.state,
      code: INSTALL_CODE,
      ip: IP,
    });

    expect(summary.status).toBe('suspended');
  });

  it('updates rather than duplicating when the same account reconnects', async () => {
    const user = await makeUser('a@example.com');

    const first = await connectFor(user);
    const second = await connectFor(user);

    expect(second.installationRecordId).toBe(first.installationRecordId);
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(1);
  });
});

describe('stale and forged state', () => {
  it('refuses a callback with no state', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: user.userId,
        installationId: INSTALLATION_ID,
        state: '',
        code: INSTALL_CODE,
        ip: IP,
      }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(0);
  });

  it('refuses an invented state', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: user.userId,
        installationId: INSTALLATION_ID,
        state: 'non_aaaaaaaaaaaaaaaaaaaaa',
        code: INSTALL_CODE,
        ip: IP,
      }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
  });

  it('refuses a state that belongs to a different account', async () => {
    const mine = await makeUser('a@example.com');
    const theirs = await makeUser('b@example.com');
    directory.knowsInstallation(INSTALLATION_ID);
    directory.knowsInstaller(INSTALL_CODE, {
      githubUserId: 5_000_001,
      reachableInstallationIds: [INSTALLATION_ID],
    });

    const theirStart = await service.beginConnect(theirs.userId);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: mine.userId,
        installationId: INSTALLATION_ID,
        state: theirStart.state,
        code: INSTALL_CODE,
        ip: IP,
      }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(0);
  });

  it('refuses the same callback used twice', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID);
    directory.knowsInstaller(INSTALL_CODE, {
      githubUserId: 5_000_001,
      reachableInstallationIds: [INSTALLATION_ID],
    });
    const started = await service.beginConnect(user.userId);

    await service.completeSetup({
      userId: user.userId,
      installationId: INSTALLATION_ID,
      state: started.state,
      code: INSTALL_CODE,
      ip: IP,
    });

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: user.userId,
        installationId: INSTALLATION_ID,
        state: started.state,
        code: INSTALL_CODE,
        ip: IP,
      }),
    );

    expect(error.code).toBe('OAUTH_STATE_INVALID');
  });

  it('never talks to GitHub when the state is bad', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID);

    await apiErrorFrom(
      service.completeSetup({
        userId: user.userId,
        installationId: INSTALLATION_ID,
        state: 'non_aaaaaaaaaaaaaaaaaaaaa',
        code: INSTALL_CODE,
        ip: IP,
      }),
    );

    expect(directory.installationLookups).toHaveLength(0);
  });
});

describe('installation ids that are not yours', () => {
  it('refuses an installation the signed in GitHub account cannot reach', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstaller(INSTALL_CODE, {
      githubUserId: 5_000_001,
      reachableInstallationIds: [INSTALLATION_ID],
    });
    const started = await service.beginConnect(user.userId);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: user.userId,
        installationId: 404_404_404,
        state: started.state,
        code: INSTALL_CODE,
        ip: IP,
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(0);
  });

  it('works out the installation when GitHub sends none, if there is exactly one', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID);
    directory.knowsInstaller(INSTALL_CODE, {
      githubUserId: 5_000_001,
      reachableInstallationIds: [INSTALLATION_ID],
    });
    const started = await service.beginConnect(user.userId);

    const summary = await service.completeSetup({
      userId: user.userId,
      installationId: 0,
      state: started.state,
      code: INSTALL_CODE,
      ip: IP,
    });

    expect(summary.installationId).toBe(INSTALLATION_ID);
  });

  it('says to install first when the account has no installation at all', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstaller(INSTALL_CODE, {
      githubUserId: 5_000_001,
      reachableInstallationIds: [],
    });
    const started = await service.beginConnect(user.userId);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: user.userId,
        installationId: 0,
        state: started.state,
        code: INSTALL_CODE,
        ip: IP,
      }),
    );

    expect(error.code).toBe('GITHUB_NOT_CONNECTED');
    expect(error.publicMessage).toContain('Install the Nimbus app');
  });

  it('refuses an installation another account already holds', async () => {
    const owner = await makeUser('owner@example.com');
    const attacker = await makeUser('attacker@example.com');

    await connectFor(owner);
    const started = await service.beginConnect(attacker.userId);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: attacker.userId,
        installationId: INSTALLATION_ID,
        state: started.state,
        code: INSTALL_CODE,
        ip: IP,
      }),
    );

    expect(error.code).toBe('FORBIDDEN');

    const record = await githubInstallationsCollection(db.db).findOne({
      installationId: INSTALLATION_ID,
    });
    expect(record?.userId).toBe(owner.userId);
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(1);
  });

  it('lets two accounts hold two different installations', async () => {
    const first = await makeUser('a@example.com');
    const second = await makeUser('b@example.com');

    await connectFor(first, INSTALLATION_ID);
    await connectFor(second, OTHER_INSTALLATION_ID);

    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(2);
  });
});

describe('proving the installation is actually yours', () => {
  it('refuses the attack this check exists to stop', async () => {
    const victim = await makeUser('victim@example.com');
    const attacker = await makeUser('attacker@example.com');

    directory.knowsInstallation(INSTALLATION_ID);
    directory.knowsInstaller('attacker-code', {
      githubUserId: 6_000_002,
      reachableInstallationIds: [777_777_777],
    });

    const started = await service.beginConnect(attacker.userId);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: attacker.userId,
        installationId: INSTALLATION_ID,
        state: started.state,
        code: 'attacker-code',
        ip: IP,
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(0);

    directory.knowsInstaller(INSTALL_CODE, {
      githubUserId: 5_000_001,
      reachableInstallationIds: [INSTALLATION_ID],
    });
    const summary = await connectFor(victim);
    expect(summary.installationId).toBe(INSTALLATION_ID);
  });

  it('does not demand fresh proof to update an installation already proven yours', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    directory.knowsInstallation(INSTALLATION_ID);
    const started = await service.beginConnect(user.userId);

    const summary = await service.completeSetup({
      userId: user.userId,
      installationId: INSTALLATION_ID,
      state: started.state,
      code: '',
      ip: IP,
    });

    expect(summary.installationId).toBe(INSTALLATION_ID);
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(1);

    const record = await githubInstallationsCollection(db.db).findOne({
      installationId: INSTALLATION_ID,
    });
    expect(record?.installedByGitHubUserId).toBe(5_000_001);
  });

  it('still checks a proof supplied on an update, rather than ignoring it', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);

    directory.knowsInstallation(INSTALLATION_ID);
    const started = await service.beginConnect(user.userId);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: user.userId,
        installationId: INSTALLATION_ID,
        state: started.state,
        code: 'a-code-github-does-not-recognise',
        ip: IP,
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
  });

  it('still demands proof for a first association even without a code', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID);
    const started = await service.beginConnect(user.userId);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: user.userId,
        installationId: INSTALLATION_ID,
        state: started.state,
        code: '',
        ip: IP,
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(directory.installerCodes).toHaveLength(0);
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(0);
  });

  it('refuses when GitHub will not confirm the code', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID);
    const started = await service.beginConnect(user.userId);

    const error = await apiErrorFrom(
      service.completeSetup({
        userId: user.userId,
        installationId: INSTALLATION_ID,
        state: started.state,
        code: 'a-code-github-does-not-recognise',
        ip: IP,
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(await githubInstallationsCollection(db.db).countDocuments({})).toBe(0);
  });

  it('accepts an organisation install, where the account is not the installer', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID, {
      accountType: 'Organization',
      accountId: 999_111,
      accountLogin: 'some-org',
    });
    directory.knowsInstaller(INSTALL_CODE, {
      githubUserId: 5_000_001,
      reachableInstallationIds: [INSTALLATION_ID],
    });
    const started = await service.beginConnect(user.userId);

    const summary = await service.completeSetup({
      userId: user.userId,
      installationId: INSTALLATION_ID,
      state: started.state,
      code: INSTALL_CODE,
      ip: IP,
    });

    expect(summary.accountType).toBe('Organization');
    expect(summary.accountLogin).toBe('some-org');
  });

  it('records which GitHub account proved the installation', async () => {
    const user = await makeUser('a@example.com');

    await connectFor(user);

    const record = await githubInstallationsCollection(db.db).findOne({
      installationId: INSTALLATION_ID,
    });
    expect(record?.installedByGitHubUserId).toBe(5_000_001);
  });

  it('records why an unproven installation was refused', async () => {
    const attacker = await makeUser('attacker@example.com');
    directory.knowsInstallation(INSTALLATION_ID);
    directory.knowsInstaller('attacker-code', {
      githubUserId: 6_000_002,
      reachableInstallationIds: [],
    });
    const started = await service.beginConnect(attacker.userId);

    await apiErrorFrom(
      service.completeSetup({
        userId: attacker.userId,
        installationId: INSTALLATION_ID,
        state: started.state,
        code: 'attacker-code',
        ip: IP,
      }),
    );

    const events = await auditEventsCollection(db.db).find({}).toArray();
    expect(events[0]?.outcome).toBe('denied');
    expect(events[0]?.reason).toBe('installer_does_not_hold_installation');
  });
});

describe('listing repositories', () => {
  it('says plainly when no installation is connected', async () => {
    const user = await makeUser('a@example.com');

    const error = await apiErrorFrom(service.listRepositories(user.userId));

    expect(error.code).toBe('GITHUB_NOT_CONNECTED');
  });

  it('treats a suspended installation as not connected', async () => {
    const user = await makeUser('a@example.com');
    directory.knowsInstallation(INSTALLATION_ID, { suspended: true });
    directory.knowsInstaller(INSTALL_CODE, {
      githubUserId: 5_000_001,
      reachableInstallationIds: [INSTALLATION_ID],
    });
    const started = await service.beginConnect(user.userId);
    await service.completeSetup({
      userId: user.userId,
      installationId: INSTALLATION_ID,
      state: started.state,
      code: INSTALL_CODE,
      ip: IP,
    });

    const error = await apiErrorFrom(service.listRepositories(user.userId));

    expect(error.code).toBe('GITHUB_NOT_CONNECTED');
  });

  it('returns the public repositories the installation can reach', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    directory.hasRepositories([
      fakeRepository({ id: 1, name: 'alpha' }),
      fakeRepository({ id: 2, name: 'beta' }),
    ]);

    const result = await service.listRepositories(user.userId);

    expect(result.repositories.map((repo) => repo.name).sort()).toEqual(['alpha', 'beta']);
    expect(result.installation.installationId).toBe(INSTALLATION_ID);
  });

  it('never offers a private repository', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    directory.hasRepositories([
      fakeRepository({ id: 1, name: 'open' }),
      fakeRepository({ id: 2, name: 'secret', private: true }),
    ]);

    const result = await service.listRepositories(user.userId);

    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]?.name).toBe('open');
  });

  it('never offers an internal repository either', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    directory.hasRepositories([
      fakeRepository({ id: 1, name: 'internal', private: false, visibility: 'internal' }),
    ]);

    const result = await service.listRepositories(user.userId);

    expect(result.repositories).toHaveLength(0);
  });

  it('uses a token carrying only metadata read', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    directory.hasRepositories([fakeRepository({ id: 1 })]);

    await service.listRepositories(user.userId);

    expect(tokens.listingRequests).toEqual([INSTALLATION_ID]);
    expect(tokens.requests).toHaveLength(0);
  });

  it('shows one account nothing belonging to another', async () => {
    const mine = await makeUser('a@example.com');
    const theirs = await makeUser('b@example.com');

    await connectFor(mine, INSTALLATION_ID);
    await connectFor(theirs, OTHER_INSTALLATION_ID);

    const myToken = await tokens.getListingToken(INSTALLATION_ID);
    const theirToken = await tokens.getListingToken(OTHER_INSTALLATION_ID);
    directory.hasRepositoriesForToken(myToken.token, [fakeRepository({ id: 1, name: 'mine' })]);
    directory.hasRepositoriesForToken(theirToken.token, [
      fakeRepository({ id: 2, name: 'theirs' }),
    ]);

    const result = await service.listRepositories(mine.userId);

    expect(result.repositories.map((repo) => repo.name)).toEqual(['mine']);
  });

  it('drops a repository whose shape does not match the contract', async () => {
    const user = await makeUser('a@example.com');
    await connectFor(user);
    directory.hasRepositories([
      fakeRepository({ id: 1, name: 'fine' }),
      { id: 2, name: 'broken', private: false, owner: null },
    ]);

    const result = await service.listRepositories(user.userId);

    expect(result.repositories.map((repo) => repo.name)).toEqual(['fine']);
  });
});

describe('what gets written down', () => {
  it('records a successful connection', async () => {
    const user = await makeUser('a@example.com');

    await connectFor(user);

    const events = await auditEventsCollection(db.db).find({}).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('github.installation.created');
    expect(events[0]?.outcome).toBe('success');
  });

  it('records why a connection was refused', async () => {
    const owner = await makeUser('owner@example.com');
    const attacker = await makeUser('attacker@example.com');
    await connectFor(owner);
    await auditEventsCollection(db.db).deleteMany({});

    const started = await service.beginConnect(attacker.userId);
    await apiErrorFrom(
      service.completeSetup({
        userId: attacker.userId,
        installationId: INSTALLATION_ID,
        state: started.state,
        code: INSTALL_CODE,
        ip: IP,
      }),
    );

    const events = await auditEventsCollection(db.db).find({}).toArray();
    expect(events[0]?.outcome).toBe('denied');
    expect(events[0]?.reason).toBe('installation_owned_by_another_account');
    expect(events[0]?.userId).toBe(attacker.userId);
  });
});
