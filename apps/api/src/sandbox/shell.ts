import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError } from './provider.js';

const QUOTE = String.fromCharCode(39);
const ESCAPED_QUOTE = `${QUOTE}\\${QUOTE}${QUOTE}`;
const NUL = String.fromCharCode(0);

export function quoteArgument(argument: string): string {
  return `${QUOTE}${argument.split(QUOTE).join(ESCAPED_QUOTE)}${QUOTE}`;
}

export function quoteArgv(argv: readonly string[]): string {
  return argv.map(quoteArgument).join(' ');
}

export function readQuotedArgv(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let inside = false;
  let index = 0;

  while (index < command.length) {
    const character = command[index] ?? '';

    if (inside) {
      if (character === QUOTE) {
        inside = false;
      } else {
        current += character;
      }
      index += 1;
      continue;
    }

    if (character === QUOTE) {
      inside = true;
      started = true;
      index += 1;
      continue;
    }

    if (character === '\\' && command[index + 1] === QUOTE) {
      current += QUOTE;
      started = true;
      index += 2;
      continue;
    }

    if (character === ' ') {
      if (started) {
        words.push(current);
      }
      current = '';
      started = false;
      index += 1;
      continue;
    }

    current += character;
    started = true;
    index += 1;
  }

  if (inside) {
    throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That command could not be read.');
  }

  if (started) {
    words.push(current);
  }

  return words;
}

export function buildShellCommand(argv: readonly string[]): string {
  if (argv.length === 0 || argv.length > SANDBOX_LIMITS.maxArgvEntries) {
    throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That command could not be read.');
  }

  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.includes(NUL)) {
      throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That command could not be read.');
    }
  }

  const command = quoteArgv(argv);

  let recovered: string[];
  try {
    recovered = readQuotedArgv(command);
  } catch {
    throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That command could not be prepared safely.');
  }

  if (recovered.length !== argv.length) {
    throw new SandboxError('SANDBOX_COMMAND_INVALID', 'That command could not be prepared safely.');
  }

  for (let position = 0; position < argv.length; position += 1) {
    if (recovered[position] !== argv[position]) {
      throw new SandboxError(
        'SANDBOX_COMMAND_INVALID',
        'That command could not be prepared safely.',
      );
    }
  }

  return command;
}
