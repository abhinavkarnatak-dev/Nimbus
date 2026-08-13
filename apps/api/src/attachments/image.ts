import sharp, { type Metadata, type Sharp } from 'sharp';

import { ApiError } from '../http/api-error.js';
import type { ImageMimeType } from './sniff.js';

export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_DIMENSION = 8000;
export const IMAGE_QUALITY = 82;

export interface RebuiltImage {
  bytes: Buffer;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

const TOO_LARGE = 'That image is too large to process. Please attach a smaller one.';
const UNREADABLE = 'That image could not be read. Please attach a PNG, JPEG or WebP.';

function openImage(input: Buffer): Sharp {
  return sharp(input, {
    limitInputPixels: MAX_IMAGE_PIXELS,
    sequentialRead: true,
    failOn: 'warning',
    animated: false,
  });
}

function encode(pipeline: Sharp, mimeType: ImageMimeType): Sharp {
  if (mimeType === 'image/png') {
    return pipeline.png({ compressionLevel: 9, palette: false });
  }
  if (mimeType === 'image/jpeg') {
    return pipeline.jpeg({ quality: IMAGE_QUALITY, mozjpeg: true });
  }
  return pipeline.webp({ quality: IMAGE_QUALITY });
}

export async function rebuildImage(input: Buffer, mimeType: ImageMimeType): Promise<RebuiltImage> {
  let described: Metadata;

  try {
    described = await openImage(input).metadata();
  } catch (error) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', UNREADABLE, { cause: error });
  }

  const width = described.width;
  const height = described.height;

  if (width < 1 || height < 1) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', UNREADABLE);
  }

  if (width * height > MAX_IMAGE_PIXELS) {
    throw new ApiError('PAYLOAD_TOO_LARGE', TOO_LARGE);
  }

  const needsShrinking = width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION;

  let output: Buffer;

  try {
    const pipeline = openImage(input).rotate();
    const sized = needsShrinking
      ? pipeline.resize({
          width: MAX_IMAGE_DIMENSION,
          height: MAX_IMAGE_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
      : pipeline;

    output = await encode(sized, mimeType).toBuffer();
  } catch (error) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', UNREADABLE, { cause: error });
  }

  let rebuilt: Metadata;

  try {
    rebuilt = await sharp(output, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  } catch (error) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', UNREADABLE, { cause: error });
  }

  return {
    bytes: output,
    mimeType,
    width: rebuilt.width,
    height: rebuilt.height,
  };
}
