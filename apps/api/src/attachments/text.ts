import { ApiError } from '../http/api-error.js';
import { looksLikeMarkup } from './sniff.js';

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const DELETE = 0x7f;
const C1_START = 0x80;
const C1_END = 0x9f;
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export interface CheckedText {
  text: string;
  bytes: Buffer;
}

function isDisallowedControl(code: number): boolean {
  if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) {
    return false;
  }
  if (code < 0x20 || code === DELETE) {
    return true;
  }
  return code >= C1_START && code <= C1_END;
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(
      'UNSUPPORTED_MEDIA_TYPE',
      'That file is not readable text. Only plain text and Markdown are accepted.',
    );
  }
}

export function checkText(bytes: Uint8Array): CheckedText {
  const decoded = decodeUtf8(bytes);
  const text = decoded.startsWith(BYTE_ORDER_MARK) ? decoded.slice(1) : decoded;

  for (const character of text) {
    if (isDisallowedControl(character.codePointAt(0) ?? 0)) {
      throw new ApiError(
        'UNSUPPORTED_MEDIA_TYPE',
        'That file contains control characters and is not plain text.',
      );
    }
  }

  if (looksLikeMarkup(text)) {
    throw new ApiError(
      'UNSUPPORTED_MEDIA_TYPE',
      'HTML and SVG files are not accepted. Please attach plain text or Markdown.',
    );
  }

  return { text, bytes: Buffer.from(text, 'utf8') };
}
