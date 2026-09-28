import { describe, expect, it } from 'vitest';

import { messageBlocks } from './Conversation.js';

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
      { kind: 'text', text: '\nDone.' },
    ]);
  });

  it('treats an unfinished fence as code while a message is streaming', () => {
    expect(messageBlocks('```sh\npnpm test')).toEqual([
      { kind: 'code', language: 'sh', text: 'pnpm test' },
    ]);
  });
});
