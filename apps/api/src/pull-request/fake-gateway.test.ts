import { describe, expect, it } from 'vitest';

import { AI_NOTICE } from './body.js';
import { FakePullRequestGateway } from './fake-gateway.js';
import { openRequest } from './pull-request.fixtures.js';

describe('the fake behaves like the real one', () => {
  it('opens one pull request and remembers it', async () => {
    const gateway = new FakePullRequestGateway();

    const first = await gateway.open(openRequest());
    const second = await gateway.open(openRequest());

    expect(second.number).toBe(first.number);
    expect(gateway.byBranch.size).toBe(1);
  });

  it('builds a real body rather than a placeholder', async () => {
    const gateway = new FakePullRequestGateway();
    await gateway.open(openRequest());

    expect(gateway.byBranch.get(openRequest().branch)?.body).toContain(AI_NOTICE);
  });

  it('gives each new branch its own number', async () => {
    const gateway = new FakePullRequestGateway();

    const first = await gateway.open(openRequest());
    const second = await gateway.open(openRequest({ branch: 'nimbus/other-thing' }));

    expect(second.number).toBe(first.number + 1);
  });

  it('records what it was asked to do', async () => {
    const gateway = new FakePullRequestGateway();
    await gateway.open(openRequest());

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.branch).toBe(openRequest().branch);
  });
});
