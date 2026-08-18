import { SANDBOX_LIMITS } from '../../sandbox/index.js';
import {
  CODE_STRING_FLAGS,
  DENIED_PROGRAMS,
  DEPENDENCY_SUBCOMMANDS,
  GLOBALLY_DENIED_FLAGS,
  IGNORE_SCRIPTS_FLAG,
  PACKAGE_MANAGERS,
  PROGRAM_RULES,
  PYTHON_MODULES,
  PYTHON_MODULE_FLAG,
  PYTHON_PROGRAMS,
  SCRIPT_NAME_PATTERN,
  type CommandCategory,
} from './catalogue.js';

export const COMMAND_DECISIONS = ['allowed', 'approval_required', 'denied'] as const;

export type CommandDecision = (typeof COMMAND_DECISIONS)[number];

export interface CommandClassification {
  decision: CommandDecision;
  category: CommandCategory | null;
  program: string;
  subcommand: string | null;
  reason: string;
}

const NUL = String.fromCharCode(0);
const SCRIPT_SUBCOMMANDS: readonly string[] = ['run', 'run-script'];
const ARBITRARY_PACKAGE_SUBCOMMANDS: readonly string[] = ['exec', 'dlx', 'create', 'init'];

const SHORTCUT_SUBCOMMANDS: Readonly<Record<string, CommandCategory>> = {
  test: 'test',
  lint: 'lint',
  build: 'build',
  typecheck: 'typecheck',
  format: 'format',
  start: 'script',
};

function denied(program: string, subcommand: string | null, reason: string): CommandClassification {
  return { decision: 'denied', category: null, program, subcommand, reason };
}

function allowed(
  program: string,
  subcommand: string | null,
  category: CommandCategory,
): CommandClassification {
  return { decision: 'allowed', category, program, subcommand, reason: 'on_the_allowlist' };
}

function needsApproval(
  program: string,
  subcommand: string | null,
  category: CommandCategory,
  reason: string,
): CommandClassification {
  return { decision: 'approval_required', category, program, subcommand, reason };
}

function isFlag(value: string): boolean {
  return value.startsWith('-');
}

function flagName(value: string): string {
  const separator = value.indexOf('=');
  return separator === -1 ? value : value.slice(0, separator);
}

export function firstPositional(argv: readonly string[], from: number): string | null {
  for (let index = from; index < argv.length; index += 1) {
    const value = argv[index] ?? '';

    if (!isFlag(value)) {
      return value;
    }
  }
  return null;
}

function offendingFlag(program: string, argv: readonly string[]): string | null {
  for (const value of argv.slice(1)) {
    if (!isFlag(value)) {
      continue;
    }

    const name = flagName(value);

    if (GLOBALLY_DENIED_FLAGS.includes(name) || GLOBALLY_DENIED_FLAGS.includes(value)) {
      return value;
    }

    // Python one-liners are commonly used for safe compile/import checks inside
    // the isolated repository sandbox. Shells and every other interpreter remain
    // denied from evaluating a string.
    if (CODE_STRING_FLAGS.includes(name) && !(PYTHON_PROGRAMS.includes(program) && name === '-c')) {
      return value;
    }
  }
  return null;
}

function classifyPackageManager(program: string, argv: readonly string[]): CommandClassification {
  const subcommand = firstPositional(argv, 1);

  if (subcommand === null) {
    return denied(program, null, 'a package manager needs a subcommand');
  }

  if (program === 'npx') {
    return denied(program, subcommand, 'running a package fetched on demand is never allowed');
  }

  if (ARBITRARY_PACKAGE_SUBCOMMANDS.includes(subcommand)) {
    return denied(program, subcommand, 'running an arbitrary package is never allowed');
  }

  if (DEPENDENCY_SUBCOMMANDS.includes(subcommand)) {
    const clean = subcommand === 'ci' && argv.includes(IGNORE_SCRIPTS_FLAG);

    if (clean) {
      return allowed(program, subcommand, 'dependency_install');
    }

    return needsApproval(
      program,
      subcommand,
      'dependency_install',
      subcommand === 'ci'
        ? 'installing without --ignore-scripts runs package scripts'
        : 'changing dependencies downloads and runs code',
    );
  }

  if (SCRIPT_SUBCOMMANDS.includes(subcommand)) {
    const script = firstPositional(argv, argv.indexOf(subcommand) + 1);

    if (script === null || !SCRIPT_NAME_PATTERN.test(script)) {
      return denied(program, subcommand, 'that script name is not usable');
    }
    return allowed(program, subcommand, 'script');
  }

  const shortcut = SHORTCUT_SUBCOMMANDS[subcommand];
  if (shortcut !== undefined) {
    return allowed(program, subcommand, shortcut);
  }

  return denied(program, subcommand, 'that subcommand is not on the allowlist');
}

function classifyPython(program: string, argv: readonly string[]): CommandClassification {
  const moduleAt = argv.indexOf(PYTHON_MODULE_FLAG);

  if (moduleAt !== -1) {
    const wanted = argv[moduleAt + 1] ?? '';
    const category = PYTHON_MODULES[wanted];

    if (category === undefined) {
      return denied(program, wanted === '' ? null : wanted, 'that module is not on the allowlist');
    }
    return allowed(program, wanted, category);
  }

  const script = firstPositional(argv, 1);

  if (script === null) {
    return denied(program, null, 'a script or a module has to be named, or this waits for input');
  }
  return allowed(program, script, 'script');
}

export function classifyCommand(argv: readonly string[]): CommandClassification {
  if (argv.length === 0 || argv.length > SANDBOX_LIMITS.maxArgvEntries) {
    return denied('', null, 'that command could not be read');
  }

  for (const value of argv) {
    if (typeof value !== 'string' || value.includes(NUL)) {
      return denied('', null, 'that command could not be read');
    }
  }

  const program = argv[0] ?? '';

  if (program.trim() === '' || program !== program.trim()) {
    return denied(program, null, 'that command could not be read');
  }

  if (program.includes('/') || program.includes('\\')) {
    return denied(program, null, 'a program must be named, not given as a path');
  }

  if (DENIED_PROGRAMS.includes(program)) {
    return denied(program, null, 'that program is never allowed');
  }

  const rule = PROGRAM_RULES[program];
  if (rule === undefined) {
    return denied(program, null, 'that program is not on the allowlist');
  }

  const flag = offendingFlag(program, argv);
  if (flag !== null) {
    return denied(program, null, `the ${flag} option is never allowed`);
  }

  if (PACKAGE_MANAGERS.includes(program)) {
    return classifyPackageManager(program, argv);
  }

  if (PYTHON_PROGRAMS.includes(program)) {
    return classifyPython(program, argv);
  }

  const subcommand = firstPositional(argv, 1);

  if (rule.requiresSubcommand === true) {
    if (subcommand === null) {
      return denied(program, null, 'that command needs a subcommand');
    }

    const category = rule.subcommands?.[subcommand];
    if (category === undefined) {
      return denied(program, subcommand, 'that subcommand is not on the allowlist');
    }
    return allowed(program, subcommand, category);
  }
  return allowed(program, subcommand, rule.category);
}

export function describeClassificationForLog(
  classification: CommandClassification,
): Record<string, unknown> {
  return {
    decision: classification.decision,
    category: classification.category,
    program: classification.program,
    subcommand: classification.subcommand,
    reason: classification.reason,
  };
}
