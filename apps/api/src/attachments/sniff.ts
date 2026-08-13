import { IMAGE_MIME_TYPES, TEXT_MIME_TYPES, type AttachmentMimeType } from '@nimbus/contracts';

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export type TextMimeType = (typeof TEXT_MIME_TYPES)[number];

export const SIGNATURE_BYTES = 16;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

interface RefusedSignature {
  readonly label: string;
  readonly offset: number;
  readonly bytes: readonly number[];
}

function ascii(text: string): number[] {
  return Array.from(Buffer.from(text, 'ascii'));
}

const REFUSED_SIGNATURES: readonly RefusedSignature[] = [
  { label: 'a GIF image', offset: 0, bytes: ascii('GIF8') },
  { label: 'a PDF document', offset: 0, bytes: ascii('%PDF') },
  { label: 'a BMP image', offset: 0, bytes: ascii('BM') },
  { label: 'a TIFF image', offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
  { label: 'a TIFF image', offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { label: 'an icon file', offset: 0, bytes: [0x00, 0x00, 0x01, 0x00] },
  { label: 'a ZIP archive', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { label: 'a ZIP archive', offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] },
  { label: 'a gzip archive', offset: 0, bytes: [0x1f, 0x8b] },
  { label: 'a RAR archive', offset: 0, bytes: ascii('Rar!') },
  { label: 'a 7z archive', offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { label: 'an xz archive', offset: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { label: 'a tar archive', offset: 257, bytes: ascii('ustar') },
  { label: 'a Linux program', offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { label: 'a Windows program', offset: 0, bytes: ascii('MZ') },
  { label: 'a macOS program', offset: 0, bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { label: 'a macOS program or Java class file', offset: 0, bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { label: 'a script with a shebang', offset: 0, bytes: ascii('#!') },
  { label: 'an SQLite database', offset: 0, bytes: ascii('SQLite format 3') },
  { label: 'a Photoshop file', offset: 0, bytes: ascii('8BPS') },
  { label: 'an audio or video container', offset: 4, bytes: ascii('ftyp') },
  { label: 'a Matroska video', offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { label: 'an Ogg container', offset: 0, bytes: ascii('OggS') },
  { label: 'an MP3 file', offset: 0, bytes: ascii('ID3') },
  { label: 'a Windows shortcut', offset: 0, bytes: [0x4c, 0x00, 0x00, 0x00] },
];

const MARKUP_OPENINGS: readonly string[] = [
  '<?xml',
  '<svg',
  '<!doctype',
  '<html',
  '<head',
  '<body',
  '<script',
  '<iframe',
  '<meta',
  '<style',
  '<link',
  '<object',
  '<embed',
  '<base',
];

export const EXTENSIONS_BY_MIME: Readonly<Record<AttachmentMimeType, readonly string[]>> = {
  'text/plain': ['.txt', '.text', '.log'],
  'text/markdown': ['.md', '.markdown'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
};

function matchesAt(bytes: Uint8Array, signature: readonly number[], offset: number): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

export function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  if (matchesAt(bytes, PNG, 0)) {
    return 'image/png';
  }
  if (matchesAt(bytes, JPEG, 0)) {
    return 'image/jpeg';
  }
  if (matchesAt(bytes, RIFF, 0) && matchesAt(bytes, WEBP, 8)) {
    return 'image/webp';
  }
  return null;
}

export function describeRefusedType(bytes: Uint8Array): string | null {
  for (const candidate of REFUSED_SIGNATURES) {
    if (matchesAt(bytes, candidate.bytes, candidate.offset)) {
      return candidate.label;
    }
  }
  return null;
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export function looksLikeMarkup(text: string): boolean {
  const withoutMark = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const opening = withoutMark.trimStart().slice(0, 64).toLowerCase();
  return MARKUP_OPENINGS.some((marker) => opening.startsWith(marker));
}

export function fileExtension(originalName: string): string {
  const lastDot = originalName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === originalName.length - 1) {
    return '';
  }
  return originalName.slice(lastDot).toLowerCase();
}

export function extensionMatches(mimeType: AttachmentMimeType, originalName: string): boolean {
  return EXTENSIONS_BY_MIME[mimeType].includes(fileExtension(originalName));
}

export function isImageMimeType(mimeType: AttachmentMimeType): mimeType is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function isTextMimeType(mimeType: AttachmentMimeType): mimeType is TextMimeType {
  return (TEXT_MIME_TYPES as readonly string[]).includes(mimeType);
}
