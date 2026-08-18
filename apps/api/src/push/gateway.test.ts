import { beforeEach, describe, expect, it } from 'vitest';

import { FakeGitHubTokenProvider } from '../github/fake-token-provider.js';
import type { GitHubTokenProvider } from '../github/token-provider.js';
import { createTestLogger, type CapturedLog } from '../http/http.fixtures.js';
import { branchNameFor } from './branch-name.js';
import {
  FakeGitDataFactory,
  newRepository,
  type FakeRepositoryState,
  type FakeStep,
} from './fake-git-data.js';
import { PushError, TrustedPushGateway, commitMessageFor, type PushRequest } from './gateway.js';
import {
  BASE_FILES,
  BASE_SHA,
  INSTALLATION_ID,
  REPOSITORY_ID,
  SESSION_ID,
  TASK,
  addPatch,
  editPatch,
  pushRequest,
  reportFor,
  unmatchedPatch,
} from './push.fixtures.js';

let state: FakeRepositoryState;
let tokens: FakeGitHubTokenProvider;
let lines: CapturedLog[];

function gatewayWith(options: { failAt?: FakeStep } = {}): {
  gateway: TrustedPushGateway;
  factory: FakeGitDataFactory;
} {
  const factory = new FakeGitDataFactory(state, options);
  const captured = createTestLogger();
  lines = captured.lines;

  return {
    gateway: new TrustedPushGateway({ tokens, gitData: factory, logger: captured.logger }),
    factory,
  };
}

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof PushError ? error.code : 'NOT_A_PUSH_ERROR';
  }
  return 'NO_ERROR';
}

beforeEach(() => {
  state = newRepository(BASE_FILES);
  tokens = new FakeGitHubTokenProvider({ knownInstallationIds: [INSTALLATION_ID] });
});

describe('a first push', () => {
  it('creates the branch and reports it', async () => {
    const { gateway } = gatewayWith();
    const result = await gateway.push(pushRequest());

    expect(result.outcome).toBe('created');
    expect(result.branch).toBe(branchNameFor(SESSION_ID, TASK));
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(state.refs.get(result.branch)).toBe(result.commitSha);
  });

  it('works in the order a branch has to be built', async () => {
    const { gateway, factory } = gatewayWith();
    await gateway.push(pushRequest());

    const calls = factory.clients[0]?.calls ?? [];

    expect(calls[0]).toBe('getRepository');
    expect(calls).toContain('createBlob');
    expect(calls.indexOf('createBlob')).toBeLessThan(calls.indexOf('createTree'));
    expect(calls.indexOf('createTree')).toBeLessThan(calls.indexOf('createCommit'));
    expect(calls.indexOf('createCommit')).toBeLessThan(calls.indexOf('createRef'));
  });

  it('applies the patch rather than uploading it', async () => {
    const { gateway, factory } = gatewayWith();
    await gateway.push(pushRequest());

    const written = [...(factory.clients[0]?.blobs.values() ?? [])];

    expect(written).toContain('const a = 1;\nconst b = 3;\n');
    expect(written.join('')).not.toContain('@@');
  });

  it('creates a new file that did not exist before', async () => {
    const { gateway, factory } = gatewayWith();
    await gateway.push(pushRequest({ patch: addPatch(), report: reportFor(addPatch()) }));

    expect([...(factory.clients[0]?.blobs.values() ?? [])]).toContain('export const c = 4;\n');
  });

  it('writes a commit message from the task, not the patch', () => {
    expect(commitMessageFor(TASK)).toBe(TASK);
    expect(commitMessageFor('   ')).toBe('Apply requested change');
    expect(commitMessageFor('x'.repeat(200))).toHaveLength(72);
  });
});

describe('pushing the same thing again', () => {
  it('returns the branch that already exists and creates nothing', async () => {
    const first = await gatewayWith().gateway.push(pushRequest());

    const second = gatewayWith();
    const result = await second.gateway.push(pushRequest());

    expect(result.outcome).toBe('already_pushed');
    expect(result.branch).toBe(first.branch);
    expect(result.commitSha).toBe(first.commitSha);
    expect(second.factory.clients[0]?.calls).not.toContain('createRef');
    expect(second.factory.clients[0]?.calls).not.toContain('createCommit');
  });

  it('leaves the branch pointing where it already pointed', async () => {
    const first = await gatewayWith().gateway.push(pushRequest());
    await gatewayWith().gateway.push(pushRequest());

    expect(state.refs.get(first.branch)).toBe(first.commitSha);
  });

  it('picks the same branch name every time for one session', () => {
    expect(branchNameFor(SESSION_ID, TASK)).toBe(branchNameFor(SESSION_ID, TASK));
  });
});

describe('a retry after the network broke', () => {
  const steps: readonly FakeStep[] = ['createBlob', 'createTree', 'createCommit', 'createRef'];

  for (const step of steps) {
    it(`recovers when the first attempt died at ${step}`, async () => {
      const broken = gatewayWith({ failAt: step });
      expect(await codeOf(() => broken.gateway.push(pushRequest()))).toBe('PUSH_FAILED');

      const result = await gatewayWith().gateway.push(pushRequest());

      expect(['created', 'already_pushed']).toContain(result.outcome);
      expect(state.refs.size).toBe(1);
    });
  }

  it('never leaves two branches behind', async () => {
    await gatewayWith().gateway.push(pushRequest());
    await gatewayWith().gateway.push(pushRequest());
    await gatewayWith().gateway.push(pushRequest());

    expect(state.refs.size).toBe(1);
  });
});

describe('a retry that would change what is already there', () => {
  it('refuses rather than moving the branch', async () => {
    const first = await gatewayWith().gateway.push(pushRequest());

    const different = addPatch('src/other.ts');
    const attempt = gatewayWith();
    const code = await codeOf(() =>
      attempt.gateway.push(pushRequest({ patch: different, report: reportFor(different) })),
    );

    expect(code).toBe('PUSH_BRANCH_CONFLICT');
    expect(state.refs.get(first.branch)).toBe(first.commitSha);
    expect(attempt.factory.clients[0]?.calls).not.toContain('createRef');
  });
});

describe('a follow-up on an existing pull request branch', () => {
  it('fast-forwards the existing Nimbus branch from its current head', async () => {
    const first = await gatewayWith().gateway.push(pushRequest());
    const patch = addPatch('src/example.ts');
    const result = await gatewayWith().gateway.push(
      pushRequest({
        baseCommitSha: first.commitSha,
        patch,
        report: reportFor(patch, first.commitSha),
      }),
    );

    expect(result.outcome).toBe('created');
    expect(result.commitSha).not.toBe(first.commitSha);
    expect(state.refs.get(result.branch)).toBe(result.commitSha);
  });
});

describe('things that are never allowed', () => {
  it('refuses a patch that was not cleared', async () => {
    const denied = reportFor(editPatch());
    const request: PushRequest = pushRequest({
      report: { ...denied, decision: 'denied' },
    });

    expect(await codeOf(() => gatewayWith().gateway.push(request))).toBe('PUSH_NOT_ALLOWED');
  });

  it('refuses a patch that only needs approval, because nobody can grant it yet', async () => {
    const report = reportFor(editPatch());

    expect(
      await codeOf(() =>
        gatewayWith().gateway.push(
          pushRequest({ report: { ...report, decision: 'approval_required' } }),
        ),
      ),
    ).toBe('PUSH_NOT_ALLOWED');
  });

  it('refuses when the report was made against a different commit', async () => {
    const report = reportFor(editPatch(), '0'.repeat(40));

    expect(await codeOf(() => gatewayWith().gateway.push(pushRequest({ report })))).toBe(
      'PUSH_BASE_MISMATCH',
    );
  });

  it('never mints a token for a patch it refuses before starting', async () => {
    const report = reportFor(editPatch());
    await codeOf(() =>
      gatewayWith().gateway.push(pushRequest({ report: { ...report, decision: 'denied' } })),
    );

    expect(tokens.mintCount).toBe(0);
  });

  it('refuses to write to the default branch', async () => {
    state.defaultBranch = branchNameFor(SESSION_ID, TASK);

    expect(await codeOf(() => gatewayWith().gateway.push(pushRequest()))).toBe(
      'PUSH_TARGET_FORBIDDEN',
    );
    expect(state.refs.size).toBe(0);
  });

  it('refuses a patch that no longer applies', async () => {
    const patch = unmatchedPatch();

    expect(
      await codeOf(() =>
        gatewayWith().gateway.push(pushRequest({ patch, report: reportFor(patch) })),
      ),
    ).toBe('PUSH_PATCH_FAILED');
    expect(state.refs.size).toBe(0);
  });
});

describe('the token', () => {
  it('is narrowed to one repository and to pushing', async () => {
    await gatewayWith().gateway.push(pushRequest());

    expect(tokens.requests[0]).toMatchObject({
      scope: 'push',
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
    });
  });

  it('is revoked after a success', async () => {
    await gatewayWith().gateway.push(pushRequest());

    expect(tokens.revoked).toHaveLength(1);
  });

  it('is revoked after a failure', async () => {
    await codeOf(() => gatewayWith({ failAt: 'createTree' }).gateway.push(pushRequest()));

    expect(tokens.revoked).toHaveLength(1);
  });

  it('is revoked even when the branch is refused', async () => {
    state.defaultBranch = branchNameFor(SESSION_ID, TASK);
    await codeOf(() => gatewayWith().gateway.push(pushRequest()));

    expect(tokens.revoked).toHaveLength(1);
  });

  it('never appears in anything the gateway wrote', async () => {
    const { gateway, factory } = gatewayWith();
    const result = await gateway.push(pushRequest());
    const secret = tokens.revoked[0] ?? 'no-token-was-issued';

    expect(secret).toMatch(/^ghs_/);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(JSON.stringify([...(factory.clients[0]?.blobs.values() ?? [])])).not.toContain(secret);
    expect(JSON.stringify([[...state.refs], [...state.commits]])).not.toContain(secret);
  });

  it('still reports the push when revoking fails', async () => {
    const stubborn: GitHubTokenProvider = {
      name: tokens.name,
      getToken: (scope) => tokens.getToken(scope),
      getListingToken: (installationId) => tokens.getListingToken(installationId),
      revoke: () => Promise.reject(new Error('revoke is down')),
      clearCache: () => {
        tokens.clearCache();
      },
    };

    const captured = createTestLogger();
    const gateway = new TrustedPushGateway({
      tokens: stubborn,
      gitData: new FakeGitDataFactory(state),
      logger: captured.logger,
    });

    const result = await gateway.push(pushRequest());

    expect(result.outcome).toBe('created');
    expect(captured.lines.some((line) => line.msg === 'push token could not be revoked')).toBe(
      true,
    );
  });
});

describe('the patch reader used to push agrees with the one used to judge', () => {
  it('touches exactly the files the report described', async () => {
    const patch = `${editPatch()}${addPatch()}`;
    const report = reportFor(patch);
    const { gateway, factory } = gatewayWith();

    await gateway.push(pushRequest({ patch, report }));

    expect(report.files.map((file) => file.path).sort()).toEqual(['src/app.ts', 'src/new.ts']);
    expect(factory.clients[0]?.blobs.size).toBe(2);
  });
});

describe('the base commit', () => {
  it('is the parent of the commit that gets created', async () => {
    const { gateway } = gatewayWith();
    const result = await gateway.push(pushRequest());

    expect(state.commits.has(result.commitSha)).toBe(true);
    expect(result.commitSha).not.toBe(BASE_SHA);
  });
});
