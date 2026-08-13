import { describe, expect, it } from 'vitest';

import { AttachmentSweeper, SWEEP_RESOURCE, type ExpiredAttachmentRemover } from './sweeper.js';

class RecordingRemover implements ExpiredAttachmentRemover {
  readonly limits: number[] = [];

  constructor(private readonly removed: string[] = []) {}

  async removeExpired(limit: number): Promise<string[]> {
    this.limits.push(limit);
    return Promise.resolve(this.removed);
  }
}

class FailingRemover implements ExpiredAttachmentRemover {
  async removeExpired(): Promise<string[]> {
    return Promise.reject(new Error('storage is down'));
  }
}

describe('AttachmentSweeper', () => {
  it('asks for expired attachments and reports what went', async () => {
    const remover = new RecordingRemover(['att_a', 'att_b']);
    const sweeper = new AttachmentSweeper({ attachments: remover, maxRemovals: 25 });

    expect(await sweeper.sweep()).toEqual(['att_a', 'att_b']);
    expect(remover.limits).toEqual([25]);
  });

  it('takes the lock before sweeping', async () => {
    const asked: string[] = [];
    const sweeper = new AttachmentSweeper({
      attachments: new RecordingRemover(['att_a']),
      withLock: async (resource, run) => {
        asked.push(resource);
        return run();
      },
    });

    await sweeper.sweep();
    expect(asked).toEqual([SWEEP_RESOURCE]);
  });

  it('does nothing when another instance holds the lock', async () => {
    const remover = new RecordingRemover();
    const sweeper = new AttachmentSweeper({
      attachments: remover,
      withLock: async () => Promise.resolve(null),
    });

    expect(await sweeper.sweep()).toBeNull();
    expect(remover.limits).toHaveLength(0);
  });

  it('survives a failure rather than crashing the process', async () => {
    const sweeper = new AttachmentSweeper({ attachments: new FailingRemover() });
    expect(await sweeper.sweep()).toBeNull();
  });

  it('starting twice does not run two timers', () => {
    const sweeper = new AttachmentSweeper({
      attachments: new RecordingRemover(),
      intervalMs: 60_000,
    });

    sweeper.start();
    sweeper.start();
    sweeper.stop();
    sweeper.stop();
  });
});
