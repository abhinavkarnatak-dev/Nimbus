import { CONTRACTS_WIRE_VERSION, type ServerEvent } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { toEventEnvelope, type SessionEventDocument } from './session-event.js';

describe('stored event compatibility', () => {
  it('upgrades an older string agent message to the current identified shape', () => {
    const document: SessionEventDocument = {
      sessionId: 'ses_V1StGXR8Z5jdHi6BmyTab',
      userId: 'usr_V1StGXR8Z5jdHi6BmyTab',
      sequence: 7,
      type: 'agent.message',
      event: { type: 'agent.message', message: 'an older note' } as unknown as ServerEvent,
      emittedAt: new Date('2026-08-16T10:00:00.000Z'),
      expiresAt: new Date('2026-09-15T10:00:00.000Z'),
    };

    const first = toEventEnvelope(document);
    const again = toEventEnvelope(document);

    expect(first.v).toBe(CONTRACTS_WIRE_VERSION);
    expect(first.event).toMatchObject({
      type: 'agent.message',
      message: {
        messageId: expect.stringMatching(/^msg_/) as string,
        role: 'agent',
        text: 'an older note',
        sentAt: '2026-08-16T10:00:00.000Z',
      },
    });
    expect(again.event).toEqual(first.event);
  });
});
