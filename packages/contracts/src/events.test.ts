import { describe, expect, it } from 'vitest';

import {
  SERVER_EVENT_TYPES,
  ServerEventSchema,
  SessionEventEnvelopeSchema,
  SubscribeSessionPayloadSchema,
} from './events.js';
import { LIMITS } from './limits.js';
import {
  approvalRequestFixture,
  checkResultFixture,
  fileChangeFixture,
  pullRequestFixture,
  sessionMessageFixture,
  toolInvocationFixture,
  VALID_SESSION_ID,
  VALID_TIMESTAMP,
} from './session.fixtures.js';
import { CONTRACTS_WIRE_VERSION } from './version.js';

const eventByType = {
  'session.status': {
    type: 'session.status',
    status: 'working',
    progress: { step: 4, maxSteps: 30, currentActivity: null },
  },
  'agent.message': {
    type: 'agent.message',
    message: { ...sessionMessageFixture(), role: 'agent', text: 'Reading the date helper' },
  },
  'agent.message.delta': {
    type: 'agent.message.delta',
    messageId: sessionMessageFixture().messageId,
    text: 'Reading the ',
    sentAt: VALID_TIMESTAMP,
  },
  'agent.question': {
    type: 'agent.question',
    question: 'Which date format should invoices use?',
    expiresAt: VALID_TIMESTAMP,
  },
  'agent.approval_required': {
    type: 'agent.approval_required',
    approval: approvalRequestFixture(),
  },
  'tool.started': { type: 'tool.started', invocation: toolInvocationFixture() },
  'tool.output': {
    type: 'tool.output',
    toolCallId: 'call_01',
    stream: 'stdout',
    chunk: 'ok',
    truncated: false,
  },
  'tool.completed': {
    type: 'tool.completed',
    toolCallId: 'call_01',
    tool: 'read_file',
    outcome: 'succeeded',
    durationMs: 12,
    summary: 'Read 40 lines',
  },
  'files.changed': { type: 'files.changed', files: [fileChangeFixture()] },
  'checks.updated': { type: 'checks.updated', checks: [checkResultFixture()] },
  'pr.created': { type: 'pr.created', pullRequest: pullRequestFixture() },
  'session.failed': {
    type: 'session.failed',
    failure: { code: 'CHECKS_FAILED', message: 'The test suite failed' },
  },
  'session.cancelled': { type: 'session.cancelled', cancelledAt: VALID_TIMESTAMP },
} as const satisfies Record<(typeof SERVER_EVENT_TYPES)[number], object>;

const envelope = (event: unknown, overrides: Record<string, unknown> = {}) => ({
  v: CONTRACTS_WIRE_VERSION,
  sequence: 1,
  sessionId: VALID_SESSION_ID,
  emittedAt: VALID_TIMESTAMP,
  event,
  ...overrides,
});

describe('server events', () => {
  it('defines a schema branch for every declared event type', () => {
    for (const type of SERVER_EVENT_TYPES) {
      const result = ServerEventSchema.safeParse(eventByType[type]);
      expect(result.success, `event ${type} failed to parse`).toBe(true);
    }
  });

  it('declares no duplicate event types', () => {
    expect(new Set(SERVER_EVENT_TYPES).size).toBe(SERVER_EVENT_TYPES.length);
  });

  it('rejects an unknown event type', () => {
    expect(ServerEventSchema.safeParse({ type: 'agent.reasoning', text: 'hidden' }).success).toBe(
      false,
    );
  });

  it('does not advertise the removed snapshot event', () => {
    expect(SERVER_EVENT_TYPES).not.toContain('session.snapshot');
    expect(ServerEventSchema.safeParse({ type: 'session.snapshot', session: {} }).success).toBe(
      false,
    );
  });

  it('rejects a payload from one event type wearing another type tag', () => {
    expect(
      ServerEventSchema.safeParse({ type: 'pr.created', message: 'not a pull request' }).success,
    ).toBe(false);
  });

  it('rejects extra keys on an otherwise valid event', () => {
    expect(
      ServerEventSchema.safeParse({ ...eventByType['agent.message'], reasoning: 'hidden thoughts' })
        .success,
    ).toBe(false);
  });

  it('caps a single tool output chunk', () => {
    expect(
      ServerEventSchema.safeParse({
        ...eventByType['tool.output'],
        chunk: 'x'.repeat(LIMITS.toolOutputChunkMaxChars + 1),
      }).success,
    ).toBe(false);
  });

  it('accepts a truncated tool output chunk at the cap', () => {
    expect(
      ServerEventSchema.safeParse({
        ...eventByType['tool.output'],
        chunk: 'x'.repeat(LIMITS.toolOutputChunkMaxChars),
        truncated: true,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown failure code', () => {
    expect(
      ServerEventSchema.safeParse({
        type: 'session.failed',
        failure: { code: 'SOMETHING_BROKE', message: 'oops' },
      }).success,
    ).toBe(false);
  });
});

describe('session event envelope', () => {
  it('accepts an envelope carrying the current wire version', () => {
    expect(
      SessionEventEnvelopeSchema.safeParse(envelope(eventByType['agent.message'])).success,
    ).toBe(true);
  });

  it('rejects a newer wire version rather than guessing at the shape', () => {
    expect(
      SessionEventEnvelopeSchema.safeParse(
        envelope(eventByType['agent.message'], { v: CONTRACTS_WIRE_VERSION + 1 }),
      ).success,
    ).toBe(false);
  });

  it('rejects an older wire version', () => {
    expect(
      SessionEventEnvelopeSchema.safeParse(
        envelope(eventByType['agent.message'], { v: CONTRACTS_WIRE_VERSION - 1 }),
      ).success,
    ).toBe(false);
  });

  it('rejects a missing wire version', () => {
    const { v: _v, ...withoutVersion } = envelope(eventByType['agent.message']);
    expect(SessionEventEnvelopeSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('requires a positive sequence, since replay depends on ordering', () => {
    for (const sequence of [0, -1, 1.5, '1']) {
      expect(
        SessionEventEnvelopeSchema.safeParse(envelope(eventByType['agent.message'], { sequence }))
          .success,
      ).toBe(false);
    }
  });

  it('rejects an envelope whose session id is not a session id', () => {
    expect(
      SessionEventEnvelopeSchema.safeParse(
        envelope(eventByType['agent.message'], { sessionId: 'usr_0123456789abcdefghijk' }),
      ).success,
    ).toBe(false);
  });

  it('rejects extra envelope keys', () => {
    expect(
      SessionEventEnvelopeSchema.safeParse(
        envelope(eventByType['agent.message'], { userId: 'usr_0123456789abcdefghijk' }),
      ).success,
    ).toBe(false);
  });
});

describe('client subscribe payload', () => {
  const valid = () => ({
    v: CONTRACTS_WIRE_VERSION,
    sessionId: VALID_SESSION_ID,
    lastEventSequence: 0,
  });

  it('accepts a fresh subscription and a resume point', () => {
    expect(SubscribeSessionPayloadSchema.parse(valid()).lastEventSequence).toBe(0);
    expect(
      SubscribeSessionPayloadSchema.parse({ ...valid(), lastEventSequence: 12 }).lastEventSequence,
    ).toBe(12);
  });

  it('rejects a negative resume point', () => {
    expect(
      SubscribeSessionPayloadSchema.safeParse({ ...valid(), lastEventSequence: -1 }).success,
    ).toBe(false);
  });

  it('rejects a mismatched wire version', () => {
    expect(
      SubscribeSessionPayloadSchema.safeParse({ ...valid(), v: CONTRACTS_WIRE_VERSION + 1 })
        .success,
    ).toBe(false);
  });

  it('rejects a token supplied over the socket, which belongs in the cookie', () => {
    expect(SubscribeSessionPayloadSchema.safeParse({ ...valid(), token: 'abc' }).success).toBe(
      false,
    );
  });
});
