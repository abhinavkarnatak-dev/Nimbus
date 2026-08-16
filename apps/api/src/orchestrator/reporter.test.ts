import type { ToolInvocation } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import type { ReportedCompletion } from '../agent/execute/reporter.js';
import { CollectingActionReporter } from '../agent/execute/reporter.js';
import { CollectingEventPublisher } from '../events/publisher.js';
import { InMemorySessionRecords } from '../sessions/repository.js';
import { DurableProgressReporter, EveryReporter, LiveActionReporter } from './reporter.js';
import { orchestratorLogger, sessionDocument } from './orchestrator.fixtures.js';

const AT = new Date('2026-08-17T10:00:00.000Z');

function invocation(summary: string): ToolInvocation {
  return {
    toolCallId: 'call_3',
    tool: 'read_file',
    summary,
    paths: ['src/routing/redirect.ts'],
    startedAt: AT.toISOString(),
  };
}

function completion(step: number, summary: string): ReportedCompletion {
  return {
    toolCallId: `call_${String(step)}`,
    step,
    tool: 'read_file',
    outcome: 'ok',
    durationMs: 12,
    summary,
  };
}

async function withRun(): Promise<{
  records: InMemorySessionRecords;
  reporter: DurableProgressReporter;
  sessionId: string;
  logs: () => string;
}> {
  const captured = orchestratorLogger();
  const records = new InMemorySessionRecords();
  const session = sessionDocument({ status: 'working' });

  await records.insert(session);

  return {
    records,
    sessionId: session.sessionId,
    logs: captured.text,
    reporter: new DurableProgressReporter({
      records,
      sessionId: session.sessionId,
      logger: captured.logger,
      now: () => AT,
    }),
  };
}

describe('writing what a run is doing down', () => {
  it('records the step and what it is doing when an action finishes', async () => {
    const held = await withRun();

    await held.reporter.completed(completion(7, 'read the redirect'));

    expect(held.records.documents[0]?.step).toBe(7);
    expect(held.records.documents[0]?.currentActivity).toBe('read the redirect');
  });

  it('records what it is doing when an action starts, without inventing a step', async () => {
    const held = await withRun();

    await held.reporter.completed(completion(7, 'read the redirect'));
    await held.reporter.started(invocation('running the unit tests'));

    expect(held.records.documents[0]?.currentActivity).toBe('running the unit tests');
    expect(held.records.documents[0]?.step).toBe(7);
  });

  it('moves the time the session was last active', async () => {
    const held = await withRun();

    await held.reporter.completed(completion(1, 'read the redirect'));

    expect(held.records.documents[0]?.lastActivityAt).toStrictEqual(AT);
  });

  it('never lets the step go backwards', async () => {
    const held = await withRun();

    await held.reporter.completed(completion(9, 'read the redirect'));
    await held.reporter.completed(completion(2, 'read it again'));

    expect(held.records.documents[0]?.step).toBe(9);
  });

  it('says nothing about output, because a session document is not a terminal', async () => {
    const held = await withRun();

    await held.reporter.output();

    expect(held.records.documents[0]?.currentActivity).toBeNull();
  });

  it('lets the run carry on when the database refuses the write', async () => {
    const held = await withRun();

    held.records.recordProgress = async (): Promise<never> =>
      Promise.reject(new Error('mongo is down'));

    await expect(held.reporter.completed(completion(3, 'read it'))).resolves.toBeUndefined();
    expect(held.logs()).toContain('could not be written down');
  });

  it('writes nothing about a session that has already ended', async () => {
    const held = await withRun();
    const session = held.records.documents[0];

    if (session !== undefined) {
      session.status = 'cancelled';
    }

    await held.reporter.completed(completion(5, 'read it'));

    expect(held.records.documents[0]?.step).toBe(0);
  });
});

describe('reporting to more than one place', () => {
  it('gives every reporter the same start, output and completion', async () => {
    const first = new CollectingActionReporter();
    const second = new CollectingActionReporter();
    const both = new EveryReporter([first, second]);

    await both.started(invocation('reading'));
    await both.output({ toolCallId: 'call_3', stream: 'stdout', chunk: 'hello', truncated: false });
    await both.completed(completion(3, 'read it'));

    expect(first.order).toStrictEqual(['started', 'output', 'completed']);
    expect(second.order).toStrictEqual(['started', 'output', 'completed']);
  });

  it('carries the live one and the durable one together', async () => {
    const captured = orchestratorLogger();
    const events = new CollectingEventPublisher();
    const held = await withRun();

    const both = new EveryReporter([
      new LiveActionReporter({
        events,
        sessionId: held.sessionId,
        userId: 'usr_aaaaaaaaaaaaaaaaaaaaa',
        logger: captured.logger,
      }),
      held.reporter,
    ]);

    await both.completed(completion(4, 'read the redirect'));

    expect(events.typesFor(held.sessionId)).toStrictEqual(['tool.completed']);
    expect(held.records.documents[0]?.step).toBe(4);
  });
});
