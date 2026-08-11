import { describe, expect, it } from 'vitest';

import { REDACTED } from '../../logging/redact.js';
import {
  TRUNCATION_NOTICE,
  cleanCommandOutput,
  keepEndsOf,
  stripTerminalSequences,
} from './output.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('stripTerminalSequences', () => {
  it('leaves ordinary text alone', () => {
    expect(stripTerminalSequences('2 tests passed\nall good\n')).toBe('2 tests passed\nall good\n');
  });

  it('keeps tabs and newlines, which output genuinely needs', () => {
    expect(stripTerminalSequences('a\tb\nc')).toBe('a\tb\nc');
  });

  it('removes colour codes', () => {
    expect(stripTerminalSequences(`${ESC}[32mpassed${ESC}[0m`)).toBe('passed');
  });

  it('removes cursor movement', () => {
    expect(stripTerminalSequences(`ok${ESC}[2Aoverwritten`)).toBe('okoverwritten');
  });

  it('removes a screen clear', () => {
    expect(stripTerminalSequences(`${ESC}[2J${ESC}[Hclean`)).toBe('clean');
  });

  it('removes a window title change, which can reach outside the page entirely', () => {
    expect(stripTerminalSequences(`${ESC}]0;you have been owned${BEL}fine`)).toBe('fine');
  });

  it('removes a title sequence ended the other way', () => {
    expect(stripTerminalSequences(`${ESC}]2;title${ESC}\\rest`)).toBe('rest');
  });

  it('removes a device control string', () => {
    expect(stripTerminalSequences(`${ESC}Psomething${ESC}\\after`)).toBe('after');
  });

  it('removes a bare escape that starts nothing', () => {
    expect(stripTerminalSequences(`before${ESC}after`)).toBe('beforeafter');
  });

  it('removes a carriage return, which is how output overwrites itself', () => {
    expect(stripTerminalSequences('100%\rdone')).toBe('100%done');
  });

  it('turns windows line endings into plain ones', () => {
    expect(stripTerminalSequences('a\r\nb')).toBe('a\nb');
  });

  it('removes a bell and other invisible controls', () => {
    expect(stripTerminalSequences(`ding${BEL}dong${String.fromCharCode(0)}`)).toBe('dingdong');
  });

  it('removes the delete character and the high control block', () => {
    expect(
      stripTerminalSequences(`a${String.fromCharCode(127)}b${String.fromCharCode(155)}c`),
    ).toBe('abc');
  });

  it('leaves ordinary unicode alone', () => {
    expect(stripTerminalSequences('café ✓ 日本語')).toBe('café ✓ 日本語');
  });
});

describe('keepEndsOf', () => {
  it('returns short text unchanged', () => {
    expect(keepEndsOf('short', 100)).toEqual({ text: 'short', truncated: false, droppedChars: 0 });
  });

  it('keeps the beginning and the end, because failures print at the end', () => {
    const value = `START${'x'.repeat(500)}END`;
    const result = keepEndsOf(value, 200);

    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('START')).toBe(true);
    expect(result.text.endsWith('END')).toBe(true);
    expect(result.text).toContain(TRUNCATION_NOTICE);
  });

  it('says how much it dropped', () => {
    const result = keepEndsOf('x'.repeat(1_000), 200);

    expect(result.droppedChars).toBeGreaterThan(700);
  });

  it('stays within the limit it was given, allowing for the notice', () => {
    const result = keepEndsOf('x'.repeat(5_000), 300);

    expect(result.text.length).toBeLessThanOrEqual(300);
  });

  it('returns nothing at all when there is no room, rather than just the notice', () => {
    expect(keepEndsOf('important error', 0)).toEqual({
      text: '',
      truncated: true,
      droppedChars: 15,
    });
    expect(keepEndsOf('important error', 10).text).toBe('');
  });
});

describe('cleanCommandOutput', () => {
  it('hides a token a command printed', () => {
    const raw = 'Using token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa for auth\n';
    const cleaned = cleanCommandOutput(raw, 1_000);

    expect(cleaned.text).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(cleaned.text).toContain(REDACTED);
    expect(cleaned.redacted).toBe(true);
  });

  it.each([
    ['an authorization header', 'Authorization: Bearer abcdefghijklmnopqrst'],
    ['a database url with a password', 'connecting to postgres://user:hunter2@db/app'],
    ['an assignment', 'API_KEY=supersecretvalue123'],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'],
  ])('hides %s', (_label, raw) => {
    expect(cleanCommandOutput(raw, 1_000).redacted).toBe(true);
  });

  it('says nothing was redacted when nothing was', () => {
    const cleaned = cleanCommandOutput('2 passing\n', 1_000);

    expect(cleaned.redacted).toBe(false);
    expect(cleaned.text).toBe('2 passing\n');
  });

  it('strips escapes before redacting, so a secret cannot hide inside one', () => {
    const raw = `ghp_${ESC}[0maaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const cleaned = cleanCommandOutput(raw, 1_000);

    expect(cleaned.text).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(cleaned.redacted).toBe(true);
  });

  it('cleans and truncates together, reporting both', () => {
    const raw = `${ESC}[32m${'x'.repeat(2_000)}${ESC}[0m`;
    const cleaned = cleanCommandOutput(raw, 500);

    expect(cleaned.text).not.toContain(ESC);
    expect(cleaned.truncated).toBe(true);
    expect(cleaned.text.length).toBeLessThanOrEqual(500);
  });

  it('handles empty output', () => {
    expect(cleanCommandOutput('', 1_000)).toEqual({
      text: '',
      truncated: false,
      redacted: false,
      droppedChars: 0,
    });
  });
});
