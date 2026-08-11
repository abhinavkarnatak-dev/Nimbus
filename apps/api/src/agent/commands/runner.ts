import { LIMITS } from '@nimbus/contracts';

import type { CommandOutcome, Sandbox } from '../../sandbox/index.js';
import { SANDBOX_LIMITS } from '../../sandbox/index.js';
import type { CommandCategory } from './catalogue.js';
import { cleanCommandOutput } from './output.js';
import { classifyCommand, type CommandClassification, type CommandDecision } from './policy.js';

export const COMMAND_LIMITS = {
  outputMaxChars: 32_768,
  streamMaxChars: LIMITS.toolOutputChunkMaxChars,
  commandsPerSession: 40,
  defaultTimeoutMs: SANDBOX_LIMITS.defaultCommandTimeoutMs,
} as const;

export const COMMAND_REFUSAL_CODES = [
  'COMMAND_DENIED',
  'COMMAND_APPROVAL_REQUIRED',
  'COMMAND_BUDGET_EXHAUSTED',
] as const;

export type CommandRefusalCode = (typeof COMMAND_REFUSAL_CODES)[number];

export class CommandRefused extends Error {
  readonly code: CommandRefusalCode;
  readonly classification: CommandClassification;

  constructor(code: CommandRefusalCode, message: string, classification: CommandClassification) {
    super(message);
    this.name = 'CommandRefused';
    this.code = code;
    this.classification = classification;
  }
}

export interface RunCommandInput {
  argv: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunCommandResult {
  outcome: CommandOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  category: CommandCategory | null;
  decision: CommandDecision;
  durationMs: number;
  truncated: boolean;
  redacted: boolean;
  timedOut: boolean;
}

export class CommandRunner {
  private used = 0;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly budget: number = COMMAND_LIMITS.commandsPerSession,
  ) {}

  get commandsUsed(): number {
    return this.used;
  }

  get commandsLeft(): number {
    return Math.max(0, this.budget - this.used);
  }

  classify(argv: readonly string[]): CommandClassification {
    return classifyCommand(argv);
  }

  async run(input: RunCommandInput): Promise<RunCommandResult> {
    const classification = classifyCommand(input.argv);

    if (classification.decision === 'denied') {
      throw new CommandRefused(
        'COMMAND_DENIED',
        'That command is not allowed to run.',
        classification,
      );
    }

    if (classification.decision === 'approval_required') {
      throw new CommandRefused(
        'COMMAND_APPROVAL_REQUIRED',
        'That command needs a separate approval.',
        classification,
      );
    }

    if (this.commandsLeft === 0) {
      throw new CommandRefused(
        'COMMAND_BUDGET_EXHAUSTED',
        'This session has run as many commands as it is allowed.',
        classification,
      );
    }

    this.used += 1;

    const result = await this.sandbox.execute({
      argv: input.argv,
      timeoutMs: input.timeoutMs ?? COMMAND_LIMITS.defaultTimeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const stdout = cleanCommandOutput(result.stdout, COMMAND_LIMITS.outputMaxChars);
    const stderr = cleanCommandOutput(
      result.stderr,
      Math.max(0, COMMAND_LIMITS.outputMaxChars - stdout.text.length),
    );

    return {
      outcome: result.outcome,
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      category: classification.category,
      decision: classification.decision,
      durationMs: result.durationMs,
      truncated: result.truncated || stdout.truncated || stderr.truncated,
      redacted: stdout.redacted || stderr.redacted,
      timedOut: result.timedOut,
    };
  }
}

export function describeRunForLog(
  classification: CommandClassification,
  result: RunCommandResult,
): Record<string, unknown> {
  return {
    program: classification.program,
    subcommand: classification.subcommand,
    category: result.category,
    outcome: result.outcome,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    redacted: result.redacted,
  };
}
