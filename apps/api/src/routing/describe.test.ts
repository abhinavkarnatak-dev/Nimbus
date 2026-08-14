import { describe, expect, it } from 'vitest';

import { InMemoryAttachmentRecords } from '../attachments/repository.js';
import type { AttachmentDocument } from '../db/models/attachment.js';
import { LlmError } from '../llm/errors.js';
import { FakeVisionProvider } from '../llm/fake-vision.js';
import { capturingLogger } from '../llm/llm.fixtures.js';
import { DEFAULT_VISION_MODEL } from '../llm/models.js';
import { ImageDescriber, storedDescription } from './describe.js';
import { FakeImageBytes, attachment, textAttachment } from './routing.fixtures.js';

async function setup(
  documents: readonly AttachmentDocument[],
  vision = new FakeVisionProvider(),
  bytes = new FakeImageBytes(),
): Promise<{
  describer: ImageDescriber;
  records: InMemoryAttachmentRecords;
  vision: FakeVisionProvider;
  bytes: FakeImageBytes;
  logs: () => string;
}> {
  const records = new InMemoryAttachmentRecords();
  const captured = capturingLogger();

  for (const document of documents) {
    await records.insert(document);
  }

  return {
    describer: new ImageDescriber({ vision, records, bytes, logger: captured.logger }),
    records,
    vision,
    bytes,
    logs: captured.text,
  };
}

describe('storedDescription', () => {
  it('finds a description that is there', () => {
    expect(storedDescription(attachment({ description: 'a red box' }))).toBe('a red box');
  });

  it.each([
    ['nothing stored', undefined],
    ['an explicit nothing', null],
    ['an empty string', ''],
    ['only spaces', '   '],
  ])('treats %s as not described', (_label, description) => {
    const document: AttachmentDocument = attachment();

    if (description === undefined) {
      delete document.description;
    } else {
      document.description = description;
    }
    expect(storedDescription(document)).toBeNull();
  });
});

describe('ImageDescriber', () => {
  it('never calls the vision model when there are no images', async () => {
    const { describer, vision } = await setup([textAttachment(), textAttachment()]);

    const result = await describer.describeAll([textAttachment(), textAttachment()]);

    expect(vision.calls).toHaveLength(0);
    expect(result.images).toEqual([]);
    expect(result.reports).toEqual([]);
  });

  it('never sends a text attachment to the vision model', async () => {
    const text = textAttachment();
    const { describer, vision, bytes } = await setup([text]);

    await describer.describeAll([text]);

    expect(vision.calls).toHaveLength(0);
    expect(bytes.reads).toEqual([]);
  });

  it('describes each image once', async () => {
    const first = attachment();
    const second = attachment();
    const { describer, vision } = await setup([first, second]);

    const result = await describer.describeAll([first, second]);

    expect(vision.calls).toHaveLength(2);
    expect(result.images).toHaveLength(2);
    expect(result.images.every((image) => !image.reused)).toBe(true);
    expect(result.reports).toHaveLength(2);
  });

  it('keeps the description, so the same image is never described twice', async () => {
    const image = attachment();
    const { describer, records, vision } = await setup([image]);

    await describer.describeAll([image]);
    expect(vision.calls).toHaveLength(1);

    const stored = await records.findOwned(image.userId, image.attachmentId);
    expect(stored?.description).toBe('a fake description of an image');
    expect(stored?.describedByModel).toBe(DEFAULT_VISION_MODEL);
    expect(stored?.describedAt).toBeInstanceOf(Date);
  });

  it('reuses a stored description without calling anybody', async () => {
    const image = attachment({
      description: 'a red box saying Error 500',
      describedByModel: 'gemini-3.6-flash',
    });
    const { describer, vision, bytes } = await setup([image]);

    const result = await describer.describeAll([image]);

    expect(vision.calls).toHaveLength(0);
    expect(bytes.reads).toEqual([]);
    expect(result.images[0]?.description).toBe('a red box saying Error 500');
    expect(result.images[0]?.reused).toBe(true);
    expect(result.reports).toEqual([]);
  });

  it('describes only the images that have never been described', async () => {
    const known = attachment({ description: 'already known' });
    const fresh = attachment();
    const { describer, vision } = await setup([known, fresh]);

    const result = await describer.describeAll([known, fresh]);

    expect(vision.calls).toHaveLength(1);
    expect(result.images.map((image) => image.reused)).toEqual([true, false]);
  });

  it('carries on when one image cannot be described', async () => {
    const bad = attachment();
    const good = attachment();
    const vision = new FakeVisionProvider({
      descriptions: [{ fails: new LlmError('LLM_CONTENT_REFUSED', 'no') }],
    });
    const { describer, logs } = await setup([bad, good], vision);

    const result = await describer.describeAll([bad, good]);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.attachmentId).toBe(good.attachmentId);
    expect(result.skipped).toBe(1);
    expect(logs()).toContain('LLM_CONTENT_REFUSED');
  });

  it('carries on when the bytes cannot be read', async () => {
    const bad = attachment();
    const good = attachment();
    const { describer, vision } = await setup(
      [bad, good],
      new FakeVisionProvider(),
      new FakeImageBytes([bad.attachmentId]),
    );

    const result = await describer.describeAll([bad, good]);

    expect(result.images).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(vision.calls).toHaveLength(1);
  });

  it('never records a description for an image it failed on', async () => {
    const bad = attachment();
    const vision = new FakeVisionProvider({
      descriptions: [{ fails: new LlmError('LLM_TIMED_OUT', 'slow') }],
    });
    const { describer, records } = await setup([bad], vision);

    await describer.describeAll([bad]);

    const stored = await records.findOwned(bad.userId, bad.attachmentId);
    expect(storedDescription(stored ?? bad)).toBeNull();
  });

  it('stops after the image limit', async () => {
    const many = Array.from({ length: 9 }, () => attachment());
    const { describer, vision } = await setup(many);

    const result = await describer.describeAll(many);

    expect(vision.calls.length).toBeLessThanOrEqual(5);
    expect(result.images.length).toBeLessThanOrEqual(5);
  });

  it('reports what each description cost', async () => {
    const image = attachment();
    const { describer } = await setup([image]);

    const result = await describer.describeAll([image]);

    expect(result.reports[0]?.usage.totalTokens).toBeGreaterThan(0);
    expect(result.reports[0]?.cost.microCents).toBeGreaterThan(0);
  });

  it('never puts the description in the logs', async () => {
    const image = attachment();
    const vision = new FakeVisionProvider({
      descriptions: [{ description: 'a screenshot of somebody private diary entry' }],
    });
    const { describer, logs } = await setup([image], vision);

    await describer.describeAll([image]);

    expect(logs()).not.toContain('private diary');
  });
});
