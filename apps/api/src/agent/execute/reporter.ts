import {
  LIMITS,
  type OutputStream,
  type ToolInvocation,
  type ToolName,
  type ToolOutcome,
} from '@nimbus/contracts';

import { EXECUTE_LIMITS } from './limits.js';

export interface ReportedChunk {
  toolCallId: string;
  stream: OutputStream;
  chunk: string;
  truncated: boolean;
}

export interface ReportedCompletion {
  toolCallId: string;
  tool: ToolName;
  outcome: ToolOutcome;
  durationMs: number;
  summary: string;
}

export interface ActionReporter {
  started(invocation: ToolInvocation): Promise<void>;
  output(chunk: ReportedChunk): Promise<void>;
  completed(completion: ReportedCompletion): Promise<void>;
}

export function chunkOutput(
  text: string,
  limits: { totalMaxChars?: number; chunkMaxChars?: number } = {},
): { chunk: string; truncated: boolean }[] {
  const totalMaxChars = limits.totalMaxChars ?? EXECUTE_LIMITS.reportedOutputMaxChars;
  const chunkMaxChars = limits.chunkMaxChars ?? LIMITS.toolOutputChunkMaxChars;

  if (text === '') {
    return [];
  }

  const cut = text.length > totalMaxChars;
  const kept = cut ? text.slice(0, totalMaxChars) : text;
  const chunks: { chunk: string; truncated: boolean }[] = [];

  for (let at = 0; at < kept.length; at += chunkMaxChars) {
    chunks.push({ chunk: kept.slice(at, at + chunkMaxChars), truncated: false });
  }

  const last = chunks[chunks.length - 1];

  if (cut && last !== undefined) {
    last.truncated = true;
  }
  return chunks;
}

export class CollectingActionReporter implements ActionReporter {
  readonly starts: ToolInvocation[] = [];

  readonly chunks: ReportedChunk[] = [];

  readonly completions: ReportedCompletion[] = [];

  readonly order: string[] = [];

  #failure: Error | null = null;

  failWith(error: Error): void {
    this.#failure = error;
  }

  async started(invocation: ToolInvocation): Promise<void> {
    this.#refuse();
    this.starts.push(invocation);
    this.order.push('started');
    await Promise.resolve();
  }

  async output(chunk: ReportedChunk): Promise<void> {
    this.#refuse();
    this.chunks.push(chunk);
    this.order.push('output');
    await Promise.resolve();
  }

  async completed(completion: ReportedCompletion): Promise<void> {
    this.#refuse();
    this.completions.push(completion);
    this.order.push('completed');
    await Promise.resolve();
  }

  #refuse(): void {
    if (this.#failure !== null) {
      throw this.#failure;
    }
  }
}
