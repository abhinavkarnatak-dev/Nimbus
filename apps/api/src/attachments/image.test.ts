import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../http/api-error.js';
import {
  jpegBytes,
  jpegWithLocation,
  pngBytes,
  pngWithTrailer,
  webpBytes,
} from './attachment.fixtures.js';
import { MAX_IMAGE_DIMENSION, rebuildImage } from './image.js';
import { sniffImageType } from './sniff.js';

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof ApiError ? error.code : 'NOT_AN_API_ERROR';
  }
  return 'NO_ERROR';
}

describe('rebuildImage', () => {
  it('rebuilds a png as a png', async () => {
    const rebuilt = await rebuildImage(await pngBytes(), 'image/png');
    expect(sniffImageType(rebuilt.bytes)).toBe('image/png');
    expect(rebuilt.width).toBe(8);
    expect(rebuilt.height).toBe(8);
  });

  it('rebuilds a jpeg as a jpeg', async () => {
    const rebuilt = await rebuildImage(await jpegBytes(), 'image/jpeg');
    expect(sniffImageType(rebuilt.bytes)).toBe('image/jpeg');
  });

  it('rebuilds a webp as a webp', async () => {
    const rebuilt = await rebuildImage(await webpBytes(), 'image/webp');
    expect(sniffImageType(rebuilt.bytes)).toBe('image/webp');
  });

  it('never returns the bytes it was given', async () => {
    const original = await pngBytes();
    const rebuilt = await rebuildImage(original, 'image/png');
    expect(rebuilt.bytes.equals(original)).toBe(false);
  });

  it('drops everything hidden after the end of the image', async () => {
    const polyglot = await pngWithTrailer('\n<script>steal()</script>\n');
    expect(polyglot.toString('latin1')).toContain('steal()');

    const rebuilt = await rebuildImage(polyglot, 'image/png');
    expect(rebuilt.bytes.toString('latin1')).not.toContain('steal()');
  });

  it('strips camera and location metadata', async () => {
    const original = await jpegWithLocation();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const rebuilt = await rebuildImage(original, 'image/jpeg');
    expect((await sharp(rebuilt.bytes).metadata()).exif).toBeUndefined();
  });

  it('shrinks an image that is wider than the cap', async () => {
    const wide = await pngBytes(MAX_IMAGE_DIMENSION + 500, 10);
    const rebuilt = await rebuildImage(wide, 'image/png');
    expect(rebuilt.width).toBe(MAX_IMAGE_DIMENSION);
  });

  it('leaves a small image at its own size', async () => {
    const rebuilt = await rebuildImage(await pngBytes(40, 25), 'image/png');
    expect(rebuilt.width).toBe(40);
    expect(rebuilt.height).toBe(25);
  });

  it('refuses something that is not an image at all', async () => {
    expect(await codeOf(() => rebuildImage(Buffer.from('not an image'), 'image/png'))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('refuses a truncated image', async () => {
    const cut = (await pngBytes(64, 64)).subarray(0, 40);
    expect(await codeOf(() => rebuildImage(cut, 'image/png'))).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses an empty file', async () => {
    expect(await codeOf(() => rebuildImage(Buffer.alloc(0), 'image/png'))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });
});
