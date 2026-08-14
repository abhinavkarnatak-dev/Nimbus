export const AGENT_STATE_ERROR_CODES = [
  'STATE_INVALID',
  'STATE_TOO_LARGE',
  'STATE_HOLDS_CREDENTIAL',
  'CHECKPOINT_CORRUPT',
  'CHECKPOINT_STALE',
  'BUDGET_EXHAUSTED',
] as const;

export type AgentStateErrorCode = (typeof AGENT_STATE_ERROR_CODES)[number];

export interface AgentStateErrorOptions {
  cause?: unknown;
  detail?: string;
}

export class AgentStateError extends Error {
  readonly code: AgentStateErrorCode;

  readonly detail: string | null;

  constructor(code: AgentStateErrorCode, message: string, options: AgentStateErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgentStateError';
    this.code = code;
    this.detail = options.detail ?? null;
  }
}

export function isAgentStateError(value: unknown): value is AgentStateError {
  return value instanceof AgentStateError;
}
