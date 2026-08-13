import { describe, expect, it } from 'vitest';

import { branchNameFor } from './branch-name.js';
import { FakePushGateway } from './fake-gateway.js';
import { PushError } from './gateway.js';
import { SESSION_ID, TASK, addPatch, editPatch, pushRequest, reportFor } from './push.fixtures.js';

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof PushError ? error.code : 'NOT_A_PUSH_ERROR';
  }
  return 'NO_ERROR';
}

describe('the fake refuses everything the real one refuses', () => {
  it('refuses a patch that was not cleared', async () => {
    const gateway = new FakePushGateway();
    const report = reportFor(editPatch());

    expect(
      await codeOf(() => gateway.push(pushRequest({ report: { ...report, decision: 'denied' } }))),
    ).toBe('PUSH_NOT_ALLOWED');
  });

  it('refuses a report made against a different commit', async () => {
    const gateway = new FakePushGateway();

    expect(
      await codeOf(() =>
        gateway.push(pushRequest({ report: reportFor(editPatch(), '0'.repeat(40)) })),
      ),
    ).toBe('PUSH_BASE_MISMATCH');
  });

  it('refuses the default branch', async () => {
    const gateway = new FakePushGateway({ defaultBranch: branchNameFor(SESSION_ID, TASK) });

    expect(await codeOf(() => gateway.push(pushRequest()))).toBe('PUSH_TARGET_FORBIDDEN');
  });

  it('refuses to move a branch that already holds something else', async () => {
    const gateway = new FakePushGateway();
    await gateway.push(pushRequest());

    const different = addPatch('src/other.ts');

    expect(
      await codeOf(() =>
        gateway.push(pushRequest({ patch: different, report: reportFor(different) })),
      ),
    ).toBe('PUSH_BRANCH_CONFLICT');
  });
});

describe('the fake behaves like the real one when things go well', () => {
  it('creates once and then reports the same branch', async () => {
    const gateway = new FakePushGateway();

    const first = await gateway.push(pushRequest());
    const second = await gateway.push(pushRequest());

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('already_pushed');
    expect(second.commitSha).toBe(first.commitSha);
    expect(gateway.branches.size).toBe(1);
  });

  it('records what it was asked to do', async () => {
    const gateway = new FakePushGateway();
    await gateway.push(pushRequest());

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.sessionId).toBe(SESSION_ID);
  });

  it('produces a commit sha of the right shape', async () => {
    const result = await new FakePushGateway().push(pushRequest());

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
