import type { RunInput } from '../agent/graph/graph.js';
import type { SessionDocument } from '../db/models/session.js';

export interface PreparedRun {
  installationId: number;
  input: RunInput;
  finish: () => Promise<void>;
}

export interface SessionWorkshop {
  readonly name: string;
  prepare(session: SessionDocument, options: { signal: AbortSignal }): Promise<PreparedRun>;
}

export class WorkshopError extends Error {
  readonly reason: 'no_installation' | 'no_commit' | 'stopped' | 'sandbox' | 'models';

  constructor(
    reason: 'no_installation' | 'no_commit' | 'stopped' | 'sandbox' | 'models',
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorkshopError';
    this.reason = reason;
  }
}
