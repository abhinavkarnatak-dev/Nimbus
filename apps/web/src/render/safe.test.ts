import { describe, expect, it } from 'vitest';

import {
  RENDER_LIMITS,
  bound,
  isRenderable,
  plainText,
  safeHref,
  stripEscapes,
  terminalLines,
} from './safe.js';

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

describe('taking the terminal out of terminal output', () => {
  it('removes colour codes and keeps the words', () => {
    expect(stripEscapes(`${ESCAPE}[31mfailed${ESCAPE}[0m`)).toBe('failed');
  });

  it('removes a cursor move, so output cannot redraw the page', () => {
    expect(stripEscapes(`before${ESCAPE}[2J${ESCAPE}[Hafter`)).toBe('beforeafter');
  });

  it('removes a window title sequence, which can otherwise carry anything', () => {
    expect(stripEscapes(`${ESCAPE}]0;pwned${BELL}ok`)).toBe('ok');
  });

  it('removes a lone escape that is not part of a sequence', () => {
    expect(stripEscapes(`a${ESCAPE}Mb`)).toBe('ab');
  });

  it('keeps the whitespace a reader needs', () => {
    expect(stripEscapes('one\ttwo\nthree')).toBe('one\ttwo\nthree');
  });

  it('removes the control characters a reader never needs', () => {
    expect(stripEscapes(`a${String.fromCharCode(0)}b${String.fromCharCode(127)}c`)).toBe('abc');
  });

  it('removes the marks that reorder text against the reader', () => {
    expect(stripEscapes('safe‮detunk')).toBe('safedetunk');
    expect(stripEscapes('a​b﻿c')).toBe('abc');
  });

  it('decides one character at a time, and says so', () => {
    expect(isRenderable('\n')).toBe(true);
    expect(isRenderable('\t')).toBe(true);
    expect(isRenderable('A')).toBe(true);
    expect(isRenderable(String.fromCharCode(0))).toBe(false);
    expect(isRenderable(String.fromCodePoint(0x202e))).toBe(false);
  });

  it('keeps an emoji whole rather than breaking it into halves', () => {
    expect(stripEscapes('a🧑💻b')).toBe('a🧑💻b');
  });

  it('still removes the joiner inside an emoji sequence, because invisible is invisible', () => {
    const joined = '🧑‍💻';

    expect(stripEscapes(joined)).toBe('🧑💻');
    expect(stripEscapes(joined)).not.toContain(String.fromCodePoint(0x200d));
  });
});

describe('keeping output inside its box', () => {
  it('shortens a long string and says it did', () => {
    expect(bound('abcdef', 3)).toBe('abc…');
  });

  it('leaves a short string exactly as it was', () => {
    expect(bound('abc', 3)).toBe('abc');
  });

  it('collapses an inline note onto one line', () => {
    expect(plainText('  a\n\n  b  ')).toBe('a b');
  });

  it('bounds an inline note by default', () => {
    expect(plainText('a'.repeat(2_000)).length).toBe(RENDER_LIMITS.inlineMaxChars + 1);
  });

  it('bounds every line of terminal output', () => {
    const held = terminalLines(`${'a'.repeat(5_000)}\nshort`);

    expect(held.lines[0]?.length).toBe(RENDER_LIMITS.lineMaxChars + 1);
    expect(held.lines[1]).toBe('short');
  });

  it('stops after enough lines and says there were more', () => {
    const held = terminalLines(Array.from({ length: 5_000 }, () => 'x').join('\n'));

    expect(held.lines).toHaveLength(RENDER_LIMITS.linesMax);
    expect(held.truncated).toBe(true);
  });

  it('does not claim truncation when there was none', () => {
    expect(terminalLines('one\ntwo').truncated).toBe(false);
  });

  it('treats every line ending the same way', () => {
    expect(terminalLines('a\r\nb\rc\nd').lines).toStrictEqual(['a', 'b', 'c', 'd']);
  });
});

describe('a link the page is willing to follow', () => {
  it('allows an https pull request link', () => {
    expect(safeHref('https://github.com/owner/name/pull/1')).toBe(
      'https://github.com/owner/name/pull/1',
    );
  });

  it('refuses javascript, which is the whole reason this exists', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
  });

  it('refuses a data url', () => {
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('refuses plain http, because nothing here is served over it', () => {
    expect(safeHref('http://github.com')).toBeNull();
  });

  it('refuses something that is not a url at all', () => {
    expect(safeHref('not a url')).toBeNull();
  });
});
