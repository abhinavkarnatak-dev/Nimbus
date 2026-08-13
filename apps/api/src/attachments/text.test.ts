import { describe, expect, it } from 'vitest';

import { ApiError } from '../http/api-error.js';
import { bytesOf, textBytes } from './attachment.fixtures.js';
import { checkText, decodeUtf8 } from './text.js';

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof ApiError ? error.code : 'NOT_AN_API_ERROR';
  }
  return 'NO_ERROR';
}

describe('decodeUtf8', () => {
  it('reads valid utf8', () => {
    expect(decodeUtf8(textBytes('हिन्दी and english'))).toBe('हिन्दी and english');
  });

  it('refuses bytes that are not valid utf8', () => {
    expect(codeOf(() => decodeUtf8(bytesOf([0xff, 0xfe, 0xfd])))).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses a lone surrogate half', () => {
    expect(codeOf(() => decodeUtf8(bytesOf([0xed, 0xa0, 0x80])))).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('checkText', () => {
  it('accepts an ordinary error log', () => {
    const checked = checkText(textBytes('Error: cannot read x\n  at line 4\r\n'));
    expect(checked.text).toContain('cannot read x');
  });

  it('accepts tabs, newlines and carriage returns', () => {
    expect(checkText(textBytes('a\tb\nc\r\nd')).text).toBe('a\tb\nc\r\nd');
  });

  it('removes a byte order mark', () => {
    const withMark = Buffer.concat([bytesOf([0xef, 0xbb, 0xbf]), textBytes('# notes')]);
    expect(checkText(withMark).text).toBe('# notes');
  });

  it('refuses a null byte', () => {
    expect(codeOf(() => checkText(bytesOf([0x61, 0x00, 0x62])))).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses an escape sequence that could repaint a terminal', () => {
    expect(codeOf(() => checkText(textBytes(`a${String.fromCharCode(0x1b)}[2Jb`)))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('refuses a delete character', () => {
    expect(codeOf(() => checkText(textBytes(`a${String.fromCharCode(0x7f)}b`)))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('refuses an html file sent as text', () => {
    expect(codeOf(() => checkText(textBytes('<!DOCTYPE html><script>x()</script>')))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('refuses an svg sent as text', () => {
    expect(codeOf(() => checkText(textBytes('<svg onload="alert(1)"></svg>')))).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('allows markdown that talks about html', () => {
    expect(checkText(textBytes('The `<div>` is broken.')).text).toContain('<div>');
  });

  it('returns bytes that match the text it accepted', () => {
    const checked = checkText(textBytes('नमस्ते'));
    expect(checked.bytes.toString('utf8')).toBe(checked.text);
  });
});
