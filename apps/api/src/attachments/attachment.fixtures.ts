import sharp, { type Sharp } from 'sharp';

import { newPrefixedId } from '../lib/id.js';

export function newUserId(): string {
  return newPrefixedId('usr');
}

function canvas(width: number, height: number): Sharp {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 20, g: 120, b: 200 },
    },
  });
}

export function pngBytes(width = 8, height = 8): Promise<Buffer> {
  return canvas(width, height).png().toBuffer();
}

export function jpegBytes(width = 8, height = 8): Promise<Buffer> {
  return canvas(width, height).jpeg().toBuffer();
}

export function webpBytes(width = 8, height = 8): Promise<Buffer> {
  return canvas(width, height).webp().toBuffer();
}

export function jpegWithLocation(): Promise<Buffer> {
  return canvas(8, 8)
    .withExif({
      IFD0: { Copyright: 'Nimbus test', Artist: 'somebody' },
      IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
    })
    .jpeg()
    .toBuffer();
}

export async function pngWithTrailer(trailer: string): Promise<Buffer> {
  return Buffer.concat([await pngBytes(), Buffer.from(trailer, 'utf8')]);
}

export function textBytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

export function bytesOf(values: readonly number[]): Buffer {
  return Buffer.from(values);
}
