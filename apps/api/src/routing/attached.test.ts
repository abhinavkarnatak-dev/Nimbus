import { describe, expect, it } from 'vitest';

import { InMemoryAttachmentRecords } from '../attachments/repository.js';
import type { AttachmentDocument } from '../db/models/attachment.js';
import { LlmError } from '../llm/errors.js';
import { FakeVisionProvider } from '../llm/fake-vision.js';
import { capturingLogger } from '../llm/llm.fixtures.js';
import { SessionAttachments, type LoadedAttachments } from './attached.js';
import { ImageDescriber, type ImageBytes } from './describe.js';
import { ROUTING_LIMITS } from './limits.js';
import { FakeImageBytes, OWNER_ID, attachment, textAttachment } from './routing.fixtures.js';

class FixedBytes implements ImageBytes {
  readonly #contents: Buffer;

  constructor(contents: Buffer) {
    this.#contents = contents;
  }

  async read(): Promise<Buffer> {
    return await Promise.resolve(this.#contents);
  }
}

async function setup(
  documents: readonly AttachmentDocument[],
  options: { vision?: FakeVisionProvider; bytes?: ImageBytes } = {},
): Promise<{
  attachments: SessionAttachments;
  records: InMemoryAttachmentRecords;
  vision: FakeVisionProvider;
  load: (ids?: readonly string[]) => Promise<LoadedAttachments>;
  logs: () => string;
}> {
  const records = new InMemoryAttachmentRecords();
  const captured = capturingLogger();
  const vision = options.vision ?? new FakeVisionProvider();
  const bytes = options.bytes ?? new FakeImageBytes();

  for (const document of documents) {
    await records.insert(document);
  }

  const attachments = new SessionAttachments({
    records,
    bytes,
    describer: new ImageDescriber({ vision, records, bytes, logger: captured.logger }),
    logger: captured.logger,
  });

  return {
    attachments,
    records,
    vision,
    logs: captured.text,
    load: async (ids?: readonly string[]) =>
      attachments.load({
        userId: OWNER_ID,
        attachmentIds: ids ?? documents.map((one) => one.attachmentId),
      }),
  };
}

describe('what a person attached', () => {
  it('reaches the run as text, under the name they uploaded', async () => {
    const file = textAttachment({ originalName: 'build.log' });
    const held = await setup([file]);

    const loaded = await held.load();

    expect(loaded.texts).toHaveLength(1);
    expect(loaded.texts[0]?.name).toBe('build.log');
    expect(loaded.texts[0]?.contents).toContain(file.attachmentId);
  });

  it('reaches the run as a description when it is a picture', async () => {
    const shot = attachment();
    const held = await setup([shot], {
      vision: new FakeVisionProvider({
        descriptions: [{ description: 'a stack trace on a red background' }],
      }),
    });

    const loaded = await held.load();

    expect(loaded.images).toHaveLength(1);
    expect(loaded.images[0]?.description).toBe('a stack trace on a red background');
    expect(loaded.images[0]?.reused).toBe(false);
  });

  it('keeps images and text apart, so each is labelled as what it is', async () => {
    const held = await setup([attachment(), textAttachment()]);

    const loaded = await held.load();

    expect(loaded.images).toHaveLength(1);
    expect(loaded.texts).toHaveLength(1);
  });

  it('costs nothing when nothing was attached', async () => {
    const held = await setup([]);

    const loaded = await held.load([]);

    expect(loaded).toEqual({ images: [], texts: [], reports: [], lost: 0 });
    expect(held.vision.calls).toHaveLength(0);
  });
});

describe('a session that is picked up again', () => {
  it('reuses the description it already paid for', async () => {
    const shot = attachment();
    const held = await setup([shot]);

    await held.load();
    const second = await held.load();

    expect(held.vision.calls).toHaveLength(1);
    expect(second.images[0]?.reused).toBe(true);
    expect(second.reports).toHaveLength(0);
  });

  it('describes the same picture only once however often it resumes', async () => {
    const held = await setup([attachment()]);

    await held.load();
    await held.load();
    await held.load();

    expect(held.vision.calls).toHaveLength(1);
  });
});

describe('what the model call costs is reported back', () => {
  it('hands back one report for every picture it had to describe', async () => {
    const held = await setup([attachment(), attachment()]);

    const loaded = await held.load();

    expect(loaded.reports).toHaveLength(2);
    expect(loaded.reports[0]?.usage.totalTokens).toBeGreaterThan(0);
  });
});

describe('an attachment that cannot be read', () => {
  it('loses that one file and keeps the rest', async () => {
    const broken = textAttachment({ originalName: 'gone.log' });
    const fine = textAttachment({ originalName: 'kept.log' });
    const held = await setup([broken, fine], {
      bytes: new FakeImageBytes([broken.attachmentId]),
    });

    const loaded = await held.load();

    expect(loaded.texts.map((one) => one.name)).toEqual(['kept.log']);
    expect(loaded.lost).toBe(1);
  });

  it('loses a picture the vision model would not look at', async () => {
    const held = await setup([attachment()], {
      vision: new FakeVisionProvider({
        descriptions: [{ fails: new LlmError('LLM_RATE_LIMITED', 'no quota left today') }],
      }),
    });

    const loaded = await held.load();

    expect(loaded.images).toHaveLength(0);
    expect(loaded.lost).toBe(1);
  });

  it('says so in the log rather than in silence', async () => {
    const broken = textAttachment();
    const held = await setup([broken], { bytes: new FakeImageBytes([broken.attachmentId]) });

    await held.load();

    expect(held.logs()).toContain('could not be read');
  });

  it('skips a record that is no longer there and counts it', async () => {
    const held = await setup([textAttachment()]);

    const loaded = await held.load(['att_routingroutinggone123']);

    expect(loaded.texts).toHaveLength(0);
    expect(loaded.lost).toBe(1);
    expect(held.logs()).toContain('no longer exists');
  });

  it('refuses to read a file belonging to somebody else', async () => {
    const other = textAttachment({ userId: 'usr_somebodyelsesomebody1' });
    const held = await setup([other]);

    const loaded = await held.load([other.attachmentId]);

    expect(loaded.texts).toHaveLength(0);
    expect(loaded.lost).toBe(1);
  });
});

describe('the limits still apply', () => {
  it('cuts a very long file down to what a prompt can hold', async () => {
    const long = 'x'.repeat(ROUTING_LIMITS.attachmentTextMaxChars + 5_000);
    const held = await setup([textAttachment()], {
      bytes: new FixedBytes(Buffer.from(long, 'utf8')),
    });

    const loaded = await held.load();

    expect(loaded.texts[0]?.contents).toHaveLength(ROUTING_LIMITS.attachmentTextMaxChars);
  });

  it('reads no more files than a session is allowed to attach', async () => {
    const many = Array.from({ length: ROUTING_LIMITS.attachmentsMax + 3 }, () => textAttachment());
    const held = await setup(many);

    const loaded = await held.load();

    expect(loaded.texts).toHaveLength(ROUTING_LIMITS.attachmentsMax);
  });

  it('does not treat a file that is not readable text as text', async () => {
    const held = await setup([textAttachment()], {
      bytes: new FixedBytes(Buffer.from([0xff, 0xfe, 0xff])),
    });

    const loaded = await held.load();

    expect(loaded.texts).toHaveLength(0);
    expect(loaded.lost).toBe(1);
  });
});
