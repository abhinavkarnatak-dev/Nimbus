import { describe, expect, it } from 'vitest';

import { messageBlocks, sliceActivityByMessage } from './Conversation.js';
import type { ToolRun } from './live.js';

describe('messageBlocks', () => {
  it('keeps ordinary chat as text', () => {
    expect(messageBlocks('I changed the backend port.')).toEqual([
      { kind: 'text', text: 'I changed the backend port.' },
    ]);
  });

  it('turns fenced snippets into code without losing the surrounding explanation', () => {
    expect(messageBlocks('Use this:\n```ts\nconst port = 3000;\n```\nDone.')).toEqual([
      { kind: 'text', text: 'Use this:\n' },
      { kind: 'code', language: 'ts', text: 'const port = 3000;' },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('treats an unfinished fence as code while a message is streaming', () => {
    expect(messageBlocks('```sh\npnpm test')).toEqual([
      { kind: 'code', language: 'sh', text: 'pnpm test' },
    ]);
  });

  it('only closes a code fence when the fence starts its own line', () => {
    expect(messageBlocks('```ts\nconst marker = "```";\nconst done = true;\n```')).toEqual([
      {
        kind: 'code',
        language: 'ts',
        text: 'const marker = "```";\nconst done = true;',
      },
    ]);
  });
});

function tool(toolCallId: string, startedAt: string): ToolRun {
  return {
    toolCallId,
    tool: 'read_file',
    summary: `Reading ${toolCallId}`,
    resultSummary: '',
    paths: [],
    startedAt,
    outcome: 'succeeded',
    durationMs: 1,
    output: '',
    truncated: false,
  };
}

describe('sliceActivityByMessage', () => {
  it('keeps work with the turn where it occurred across follow-ups', () => {
    const messages = [
      { sentAt: '2026-01-01T10:00:00.000Z' },
      { sentAt: '2026-01-01T10:01:00.000Z' },
      { sentAt: '2026-01-01T10:02:00.000Z' },
      { sentAt: '2026-01-01T10:03:00.000Z' },
    ];
    const first = tool('first', '2026-01-01T10:00:30.000Z');
    const followUp = tool('follow-up', '2026-01-01T10:02:30.000Z');

    const sliced = sliceActivityByMessage(messages, [first, followUp]);

    expect(sliced.before[1]).toEqual([first]);
    expect(sliced.before[3]).toEqual([followUp]);
    expect(sliced.after).toEqual([]);
  });

  it('leaves currently running work after the newest message', () => {
    const current = tool('current', '2026-01-01T10:04:00.000Z');
    const sliced = sliceActivityByMessage([{ sentAt: '2026-01-01T10:03:00.000Z' }], [current]);

    expect(sliced.after).toEqual([current]);
  });
});
