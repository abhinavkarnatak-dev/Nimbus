import type { ToolOutcome } from '@nimbus/contracts';

import { CommandRefused } from '../commands/runner.js';
import { ToolError } from '../tools/errors.js';

export const REGISTRY_ERROR_CODES = [
  'TOOL_UNKNOWN',
  'TOOL_INPUT_INVALID',
  'TOOL_TIMED_OUT',
  'TOOL_CANCELLED',
  'TOOL_FORBIDDEN',
] as const;

export type RegistryErrorCode = (typeof REGISTRY_ERROR_CODES)[number];

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  readonly detail: string | null;

  constructor(
    code: RegistryErrorCode,
    message: string,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RegistryError';
    this.code = code;
    this.detail = options.detail ?? null;
  }
}

export function isRegistryError(value: unknown): value is RegistryError {
  return value instanceof RegistryError;
}

export function alreadyAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

export function isAbortError(value: unknown): boolean {
  return value instanceof Error && (value.name === 'AbortError' || value.name === 'TimeoutError');
}

export function outcomeFor(error: unknown): ToolOutcome {
  if (error instanceof RegistryError) {
    switch (error.code) {
      case 'TOOL_TIMED_OUT':
        return 'timed_out';
      case 'TOOL_CANCELLED':
        return 'cancelled';
      case 'TOOL_FORBIDDEN':
        return 'denied';
      default:
        return 'failed';
    }
  }

  if (error instanceof CommandRefused) {
    return 'denied';
  }

  if (error instanceof ToolError) {
    return error.code === 'PATCH_APPROVAL_REQUIRED' ? 'denied' : 'failed';
  }

  if (isAbortError(error)) {
    return 'cancelled';
  }
  return 'failed';
}

export function codeFor(error: unknown): string {
  if (error instanceof RegistryError) {
    return error.code;
  }

  if (error instanceof CommandRefused || error instanceof ToolError) {
    return error.code;
  }
  return 'TOOL_FAILED';
}
