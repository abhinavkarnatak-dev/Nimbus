import type { ServerEvent } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { applyEvent, type LiveSession } from './live.js';

function session(): LiveSession {
  return {
    status: 'working',
    runStatus: 'working',
    deliveryStatus: null,
    progress: { step: 0, maxSteps: 30, currentActivity: null },
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

describe('tool completion activity', () => {
  it('uses the result as a readable headline when policy denied the action before it started', () => {
    const live = applyEvent(session(), completed('call_denied', 'command denied by policy'));

    expect(live.tools[0]?.summary).toBe('command denied by policy');
    expect(live.tools[0]?.resultSummary).toBe('');
  });

  it('keeps the truthful invocation headline when the tool did start', () => {
    const started = applyEvent(session(), {
      type: 'tool.started',
      invocation: {
        toolCallId: 'call_started',
        tool: 'run_command',
        summary: 'Running: pnpm test',
        paths: [],
        startedAt: '2026-01-01T10:00:00.000Z',
      },
    });
    const live = applyEvent(started, completed('call_started', 'pnpm exited 0'));

    expect(live.tools[0]?.summary).toBe('Running: pnpm test');
    expect(live.tools[0]?.resultSummary).toBe('pnpm exited 0');
  });
});
