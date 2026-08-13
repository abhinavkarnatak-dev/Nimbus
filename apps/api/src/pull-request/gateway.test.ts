import { beforeEach, describe, expect, it } from 'vitest';

import { CapturingMailer } from '../email/capturing-mailer.js';
import { MailService } from '../email/mail-service.js';
import { FakeGitHubTokenProvider } from '../github/fake-token-provider.js';
import { createTestLogger, type CapturedLog } from '../http/http.fixtures.js';
import { INSTALLATION_ID, REPOSITORY_ID } from '../push/push.fixtures.js';
import { AI_NOTICE } from './body.js';
import {
  FakePullRequestClientFactory,
  newPullRequestState,
  type FakePullRequestOptions,
  type FakePullRequestState,
} from './fake-client.js';
import { PullRequestError, TrustedPullRequestGateway, titleFor } from './gateway.js';
import { FAILING_CHECKS, NOTIFY_EMAIL, openRequest } from './pull-request.fixtures.js';

let state: FakePullRequestState;
let tokens: FakeGitHubTokenProvider;
let mailer: CapturingMailer;
let mail: MailService;
let lines: CapturedLog[];

function gatewayWith(options: FakePullRequestOptions = {}): {
  gateway: TrustedPullRequestGateway;
  clients: FakePullRequestClientFactory;
} {
  const clients = new FakePullRequestClientFactory(state, options);
  const captured = createTestLogger();
  lines = captured.lines;

  return {
    gateway: new TrustedPullRequestGateway({
      tokens,
      clients,
      mail,
      logger: captured.logger,
    }),
    clients,
  };
}

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof PullRequestError ? error.code : 'NOT_A_PULL_REQUEST_ERROR';
  }
  return 'NO_ERROR';
}

beforeEach(() => {
  state = newPullRequestState();
  tokens = new FakeGitHubTokenProvider({ knownInstallationIds: [INSTALLATION_ID] });
  mailer = new CapturingMailer();
  mail = new MailService(mailer, 'Nimbus <noreply@example.com>');
});

describe('opening a pull request', () => {
  it('looks first, then creates', async () => {
    const { gateway, clients } = gatewayWith();
    const result = await gateway.open(openRequest());

    expect(result.number).toBe(41);
    expect(result.url).toContain('/pull/41');
    expect(clients.clients[0]?.finds).toHaveLength(1);
    expect(clients.clients[0]?.created).toHaveLength(1);
  });

  it('opens it against the default branch', async () => {
    const { gateway, clients } = gatewayWith();
    await gateway.open(openRequest());

    expect(clients.clients[0]?.created[0]).toMatchObject({ baseBranch: 'main' });
  });

  it('carries the ai notice in the body', async () => {
    const { gateway, clients } = gatewayWith();
    await gateway.open(openRequest());

    expect(clients.clients[0]?.created[0]?.body).toContain(AI_NOTICE);
  });

  it('titles it from the task', () => {
    expect(titleFor('Fix the broken login redirect')).toBe('Fix the broken login redirect');
    expect(titleFor('  ')).toBe('Nimbus change');
    expect(titleFor('x'.repeat(300))).toHaveLength(72);
  });

  it('sends exactly one email', async () => {
    await gatewayWith().gateway.open(openRequest());

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(NOTIFY_EMAIL);
    expect(mailer.sent[0]?.subject).toContain('#41');
  });
});

describe('asking twice', () => {
  it('returns the same pull request and creates no second one', async () => {
    const first = await gatewayWith().gateway.open(openRequest());

    const again = gatewayWith();
    const second = await again.gateway.open(openRequest());

    expect(second.number).toBe(first.number);
    expect(again.clients.clients[0]?.created).toHaveLength(0);
    expect(state.byBranch.size).toBe(1);
  });

  it('does not send a second email', async () => {
    await gatewayWith().gateway.open(openRequest());
    await gatewayWith().gateway.open(openRequest());
    await gatewayWith().gateway.open(openRequest());

    expect(mailer.sent).toHaveLength(1);
  });
});

describe('two workers at the same moment', () => {
  it('lets the loser fetch what the winner made', async () => {
    const winner = await gatewayWith().gateway.open(openRequest());

    state.hiddenBranches.add(openRequest().branch);
    const loser = gatewayWith();
    const result = await loser.gateway.open(openRequest());

    expect(result.number).toBe(winner.number);
    expect(loser.clients.clients[0]?.created).toHaveLength(1);
    expect(loser.clients.clients[0]?.finds).toHaveLength(2);
    expect(state.byBranch.size).toBe(1);
  });

  it('does not email again after losing the race', async () => {
    await gatewayWith().gateway.open(openRequest());
    state.hiddenBranches.add(openRequest().branch);
    await gatewayWith().gateway.open(openRequest());

    expect(mailer.sent).toHaveLength(1);
  });

  it('reports honestly when the winner cannot be found afterwards', async () => {
    expect(
      await codeOf(() => gatewayWith({ raceOnCreate: true }).gateway.open(openRequest())),
    ).toBe('PULL_REQUEST_LOST');
  });
});

describe('when things break', () => {
  it('turns a failure to look into a safe error', async () => {
    expect(await codeOf(() => gatewayWith({ failFind: true }).gateway.open(openRequest()))).toBe(
      'PULL_REQUEST_FAILED',
    );
  });

  it('turns a failure to create into a safe error', async () => {
    expect(await codeOf(() => gatewayWith({ failCreate: true }).gateway.open(openRequest()))).toBe(
      'PULL_REQUEST_FAILED',
    );
    expect(mailer.sent).toHaveLength(0);
  });

  it('keeps the pull request when the email fails', async () => {
    mailer.failNextSends(new Error('smtp is down'));

    const result = await gatewayWith().gateway.open(openRequest());

    expect(result.number).toBe(41);
    expect(
      lines.some(
        (line) => line.msg === 'pull request opened but the notification could not be sent',
      ),
    ).toBe(true);
  });
});

describe('the token', () => {
  it('asks only for pull request access on one repository', async () => {
    await gatewayWith().gateway.open(openRequest());

    expect(tokens.requests[0]).toMatchObject({
      scope: 'pullRequest',
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
    });
  });

  it('is revoked after a success', async () => {
    await gatewayWith().gateway.open(openRequest());

    expect(tokens.revoked).toHaveLength(1);
  });

  it('is revoked after a failure', async () => {
    await codeOf(() => gatewayWith({ failCreate: true }).gateway.open(openRequest()));

    expect(tokens.revoked).toHaveLength(1);
  });

  it('never appears in the result, the body or the logs', async () => {
    const { gateway, clients } = gatewayWith();
    const result = await gateway.open(openRequest());
    const secret = tokens.revoked[0] ?? 'no-token-was-issued';

    expect(secret).toMatch(/^ghs_/);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(clients.clients[0]?.created[0]?.body ?? '').not.toContain(secret);
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(JSON.stringify(mailer.sent)).not.toContain(secret);
  });
});

describe('what the gateway cannot do', () => {
  it('has no way to merge, approve or close', async () => {
    const { gateway, clients } = gatewayWith();
    await gateway.open(openRequest());

    const client = clients.clients[0];
    const operations = Object.getOwnPropertyNames(Object.getPrototypeOf(client) as object);

    expect(operations).toEqual(expect.arrayContaining(['findByBranch', 'create']));
    for (const forbidden of ['merge', 'approve', 'close', 'update', 'comment']) {
      expect(operations).not.toContain(forbidden);
    }
  });
});

describe('a pull request for work whose checks failed', () => {
  it('still opens, and says so at the top', async () => {
    const { gateway, clients } = gatewayWith();
    await gateway.open(openRequest({ checks: FAILING_CHECKS }));

    const body = clients.clients[0]?.created[0]?.body ?? '';

    expect(body.startsWith('## Checks did not all pass')).toBe(true);
  });
});
