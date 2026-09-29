import {
  CONTRACTS_WIRE_VERSION,
  SessionIdSchema,
  type ServerEvent,
  type SessionEventEnvelope,
} from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { applyEvent, applySessionEvents, type LiveSession } from './live.js';

const SESSION_ID = SessionIdSchema.parse('ses_0123456789abcdefghijk');
const AT = '2026-09-28T10:00:00.000Z';

function live(): LiveSession {
  return {
    status: 'working',
    runStatus: 'working',
    deliveryStatus: null,
    progress: { step: 4, maxSteps: 30, currentActivity: 'editing the selected session' },
    messages: [],
    question: null,
    approval: null,
    failure: null,
    pullRequest: null,
    files: [],
    checks: [],
    tools: [],
  };
}

function completed(toolCallId: string, summary: string): ServerEvent {
  return {
    type: 'tool.completed',
    toolCallId,
    tool: 'run_command',
    outcome: 'denied',
    durationMs: 0,
    summary,
  };
}

function envelope(sequence: number, event: SessionEventEnvelope['event']): SessionEventEnvelope {
  return { v: CONTRACTS_WIRE_VERSION, sequence, sessionId: SESSION_ID, emittedAt: AT, event };
}

describe('tool completion activity', () => {
  it('moves the live activity headline as soon as a tool starts', () => {
    const next = applyEvent(live(), {
      type: 'tool.started',
      invocation: {
        toolCallId: 'call_live',
        tool: 'move_file',
        summary: 'Moving src/old.ts to src/new.ts',
        paths: ['src/old.ts', 'src/new.ts'],
        startedAt: AT,
      },
    });

    expect(next.progress.currentActivity).toBe('Moving src/old.ts to src/new.ts');
    expect(next.tools[0]?.outcome).toBeNull();
  });

  it('uses the result as a readable headline when policy denied the action before it started', () => {
    const next = applyEvent(live(), completed('call_denied', 'command denied by policy'));

    expect(next.tools[0]?.summary).toBe('command denied by policy');
    expect(next.tools[0]?.resultSummary).toBe('');
  });

  it('keeps the truthful invocation headline when the tool did start', () => {
    const started = applyEvent(live(), {
      type: 'tool.started',
      invocation: {
        toolCallId: 'call_started',
        tool: 'run_command',
        summary: 'Running: pnpm test',
        paths: [],
        startedAt: '2026-01-01T10:00:00.000Z',
      },
    });
    const next = applyEvent(started, completed('call_started', 'pnpm exited 0'));

    expect(next.tools[0]?.summary).toBe('Running: pnpm test');
    expect(next.tools[0]?.resultSummary).toBe('pnpm exited 0');
  });
});

describe('session event replay', () => {
  it('rebuilds tool history without replacing the authoritative session snapshot', () => {
    const next = applySessionEvents(
      live(),
      [
        envelope(1, {
          type: 'session.status',
          status: 'queued',
          progress: { step: 0, maxSteps: 30, currentActivity: 'old queued state' },
        }),
        envelope(2, {
          type: 'tool.started',
          invocation: {
            toolCallId: 'call_01',
            tool: 'read_file',
            summary: 'Read the session file',
            paths: ['src/session.ts'],
            startedAt: AT,
          },
        }),
        envelope(3, {
          type: 'tool.completed',
          toolCallId: 'call_01',
          tool: 'read_file',
          outcome: 'succeeded',
          durationMs: 12,
          summary: 'Read the session file',
        }),
      ],
      3,
    );

    expect(next.status).toBe('working');
    expect(next.progress.currentActivity).toBe('editing the selected session');
    expect(next.tools).toMatchObject([
      { toolCallId: 'call_01', outcome: 'succeeded', paths: ['src/session.ts'] },
    ]);
  });

  it('applies every event newer than the fetched snapshot in real time', () => {
    const next = applySessionEvents(
      live(),
      [
        envelope(8, {
          type: 'session.status',
          status: 'working',
          progress: { step: 5, maxSteps: 30, currentActivity: 'running checks' },
        }),
      ],
      7,
    );

    expect(next.progress).toEqual({
      step: 5,
      maxSteps: 30,
      currentActivity: 'running checks',
    });
  });
});
