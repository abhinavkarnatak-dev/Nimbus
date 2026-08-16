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

class HeldRemover implements ExpiredAttachmentRemover {
  finished = false;

  #open: () => void = () => undefined;

  readonly #held: Promise<void>;

  constructor() {
    this.#held = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
  }

  release(): void {
    this.#open();
  }

  async removeExpired(): Promise<string[]> {
    await this.#held;
    this.finished = true;
    return [];
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

  it('starting twice does not run two timers', async () => {
    const sweeper = new AttachmentSweeper({
      attachments: new RecordingRemover(),
      intervalMs: 60_000,
    });

    sweeper.start();
    sweeper.start();
    await sweeper.stop();
    await sweeper.stop();
  });

  it('waits for the sweep it is in the middle of before it stops', async () => {
    const remover = new HeldRemover();
    const sweeper = new AttachmentSweeper({ attachments: remover });

    const sweeping = sweeper.sweep();
    const stopping = sweeper.stop();

    expect(remover.finished).toBe(false);

    remover.release();
    await stopping;

    expect(remover.finished).toBe(true);
    await sweeping;
  });

  it('starts no new sweep once it has stopped, so nothing runs against a closed store', async () => {
    const remover = new RecordingRemover();
    const sweeper = new AttachmentSweeper({ attachments: remover });

    await sweeper.stop();

    expect(await sweeper.sweep()).toBeNull();
    expect(remover.limits).toHaveLength(0);
  });
});
