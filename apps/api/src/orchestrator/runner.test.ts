import { describe, expect, it } from 'vitest';

import { SANDBOX_ENV } from '../sandbox/spec.js';
import { changedFiles, SessionRunner } from './runner.js';
import {
  BACKEND_ONLY_TOKEN,
  CLEAR_SCOPE,
  FINISHING_ANSWERS,
  FakeWorkshop,
  RecordingPullRequestGateway,
  RecordingPushGateway,
  answer,
  orchestratorLogger,
  sessionDocument,
} from './orchestrator.fixtures.js';
import { WorkshopError } from './workshop.js';

function runnerFor(options: { answers?: readonly { value: unknown }[]; failWith?: Error } = {}): {
  runner: SessionRunner;
  workshop: FakeWorkshop;
  push: RecordingPushGateway;
  pullRequests: RecordingPullRequestGateway;
  logs: () => string;
} {
  const captured = orchestratorLogger();
  const push = new RecordingPushGateway();
  const pullRequests = new RecordingPullRequestGateway();

  const workshop = new FakeWorkshop({
    logger: captured.logger,
    answers: options.answers ?? FINISHING_ANSWERS,
    ...(options.failWith === undefined ? {} : { failWith: options.failWith }),
  });

  return {
    runner: new SessionRunner({
      workshop,
      push,
      pullRequests,
      logger: captured.logger,
      notifyEmailFor: async () => Promise.resolve('person@example.com'),
    }),
    workshop,
    push,
    pullRequests,
    logs: captured.text,
  };
}

describe('a run that reaches a pull request', () => {
  it('pushes the patch the validator allowed', async () => {
    const held = runnerFor();
    const outcome = await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(outcome.status).toBe('pr_created');
    expect(held.push.calls[0]?.patch).toContain('DEFAULT_DESTINATION');
  });

  it('opens the pull request against the branch that was pushed', async () => {
    const held = runnerFor();
    const outcome = await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(held.pullRequests.calls[0]?.branch).toBe(outcome.branch);
    expect(outcome.pullRequest?.branch).toBe(outcome.branch);
  });

  it('tidies up whatever happened', async () => {
    const held = runnerFor();
    await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(held.workshop.finished).toHaveLength(1);
  });
});

describe('nothing reaches GitHub unless the change is real', () => {
  it('pushes nothing when the model never finished', async () => {
    const held = runnerFor({ answers: [CLEAR_SCOPE, answer('read_file', { path: 'README.md' })] });
    const outcome = await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(outcome.status).toBe('failed');
    expect(held.push.calls).toHaveLength(0);
  });

  it('pushes nothing when the sandbox never started', async () => {
    const held = runnerFor({ failWith: new WorkshopError('sandbox', 'no machine') });
    const outcome = await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(outcome.failure?.code).toBe('SANDBOX_FAILED');
    expect(held.push.calls).toHaveLength(0);
  });

  it('says the account has no GitHub app when that is the reason', async () => {
    const held = runnerFor({ failWith: new WorkshopError('no_installation', 'gone') });
    const outcome = await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(outcome.failure?.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('tidies up even when the run fails', async () => {
    const held = runnerFor({ answers: [CLEAR_SCOPE] });
    await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(held.workshop.finished).toHaveLength(1);
  });
});

describe('when GitHub refuses', () => {
  it('records that the push failed and opens nothing', async () => {
    const held = runnerFor();
    held.push.failWith(new Error('branch conflict'));

    const outcome = await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(outcome.failure?.code).toBe('PUSH_FAILED');
    expect(held.pullRequests.calls).toHaveLength(0);
  });

  it('keeps the branch it did push when the pull request fails', async () => {
    const held = runnerFor();
    held.pullRequests.failWith(new Error('pull requests are off'));

    const outcome = await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(outcome.failure?.code).toBe('PULL_REQUEST_FAILED');
    expect(outcome.branch).not.toBeUndefined();
  });
});

describe('a cancelled run', () => {
  it('ends as cancelled rather than as a failure', async () => {
    const held = runnerFor();
    const controller = new AbortController();
    const session = sessionDocument();

    const running = held.runner.run(session, controller.signal);
    controller.abort();

    expect((await running).status).toBe('cancelled');
  });
});

describe('the sandbox never holds a credential', () => {
  it('is given no token in its environment', () => {
    const values = Object.values(SANDBOX_ENV).join(' ').toLowerCase();

    expect(values).not.toContain('ghs_');
    expect(values).not.toContain('token');
  });

  it('rents a machine whose whole specification carries no token', async () => {
    const held = runnerFor();
    await held.runner.run(sessionDocument(), new AbortController().signal);

    const spec = held.workshop.specs[0];

    expect(spec).toBeDefined();
    expect(JSON.stringify(spec)).not.toContain(BACKEND_ONLY_TOKEN);
    expect(spec?.allowInternet).toBe(false);
  });

  it('keeps the token on the side of the wall that talks to GitHub', async () => {
    const held = runnerFor();
    await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(BACKEND_ONLY_TOKEN.startsWith('ghs_')).toBe(true);
    expect(JSON.stringify(held.workshop.specs)).not.toContain('ghs_');
  });

  it('sends the token to GitHub from the backend instead', async () => {
    const held = runnerFor();
    await held.runner.run(sessionDocument(), new AbortController().signal);

    expect(held.push.calls[0]?.installationId).toBe(4_242);
  });
});

describe('changedFiles', () => {
  it('is empty when there was no patch to report on', () => {
    expect(changedFiles(null)).toEqual([]);
  });
});
