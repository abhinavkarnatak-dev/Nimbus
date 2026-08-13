import { describe, expect, it } from 'vitest';

import {
  FALLBACK_NAME,
  MAX_NAME_CHARS,
  baseName,
  contentDisposition,
  safeOriginalName,
} from './names.js';

describe('baseName', () => {
  it('drops a posix directory', () => {
    expect(baseName('../../etc/passwd')).toBe('passwd');
  });

  it('drops a windows directory', () => {
    expect(baseName('C:\\Windows\\System32\\evil.png')).toBe('evil.png');
  });

  it('drops a mixed separator path', () => {
    expect(baseName('..\\../a/b\\c.txt')).toBe('c.txt');
  });
});

describe('safeOriginalName', () => {
  it('keeps an ordinary name', () => {
    expect(safeOriginalName('screenshot.png')).toBe('screenshot.png');
  });

  it('removes any path in front of the name', () => {
    expect(safeOriginalName('../../../etc/passwd.txt')).toBe('passwd.txt');
  });

  it('removes null bytes', () => {
    expect(safeOriginalName(`shot${String.fromCharCode(0)}.png`)).toBe('shot.png');
  });

  it('removes newlines that would break a log line', () => {
    expect(safeOriginalName('shot\n\rINFO fake log entry.png')).toBe('shotINFO fake log entry.png');
  });

  it('removes right to left overrides used to disguise an extension', () => {
    const disguised = `photo${String.fromCharCode(0x202e)}gnp.exe`;
    expect(safeOriginalName(disguised)).toBe('photognp.exe');
  });

  it('collapses runs of whitespace', () => {
    expect(safeOriginalName('my    holiday   shot.png')).toBe('my holiday shot.png');
  });

  it('caps a very long name', () => {
    const long = `${'a'.repeat(4000)}.png`;
    expect(safeOriginalName(long)).toHaveLength(MAX_NAME_CHARS);
  });

  it('falls back when nothing usable is left', () => {
    expect(safeOriginalName('')).toBe(FALLBACK_NAME);
    expect(safeOriginalName('..')).toBe(FALLBACK_NAME);
    expect(safeOriginalName('.')).toBe(FALLBACK_NAME);
    expect(safeOriginalName('/')).toBe(FALLBACK_NAME);
    expect(safeOriginalName(String.fromCharCode(0, 1, 2))).toBe(FALLBACK_NAME);
  });
});

describe('contentDisposition', () => {
  it('always asks the browser to save rather than display', () => {
    expect(contentDisposition('notes.txt')).toContain('attachment;');
  });

  it('escapes a quote so the header cannot be split', () => {
    const header = contentDisposition('a"b.png');
    expect(header).toContain('filename="a_b.png"');
    expect(header).toContain("filename*=UTF-8''a%22b.png");
  });

  it('escapes a backslash', () => {
    expect(contentDisposition('a\\b.png')).toContain('filename="a_b.png"');
  });

  it('keeps non ascii names readable through the encoded form', () => {
    const header = contentDisposition('स्क्रीनशॉट.png');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).not.toContain('स');
  });

  it('never emits a raw newline', () => {
    const header = contentDisposition('a\nb.png');
    expect(header).not.toContain('\n');
  });
});
