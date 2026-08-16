import { SessionMessageSchema, type ServerEvent, type ToolInvocation } from '@nimbus/contracts';

import type {
  ActionReporter,
  ReportedChunk,
  ReportedCompletion,
  SaidMessage,
} from '../agent/execute/reporter.js';
import type { EventPublisher } from '../events/publisher.js';
import type { Logger } from '../logging/logger.js';
import type { SessionRecords } from '../sessions/repository.js';

export interface LiveReporterOptions {
  events: EventPublisher;
  sessionId: string;
  userId: string;
  logger: Logger;
}

export class LiveActionReporter implements ActionReporter {
  readonly #options: LiveReporterOptions;

  constructor(options: LiveReporterOptions) {
    this.#options = options;
  }

  async started(invocation: ToolInvocation): Promise<void> {
    await this.#say({ type: 'tool.started', invocation });
  }

  async output(chunk: ReportedChunk): Promise<void> {
    await this.#say({
      type: 'tool.output',
      toolCallId: chunk.toolCallId,
      stream: chunk.stream,
      chunk: chunk.chunk,
      truncated: chunk.truncated,
    });
  }

  async completed(completion: ReportedCompletion): Promise<void> {
    await this.#say({
      type: 'tool.completed',
      toolCallId: completion.toolCallId,
      tool: completion.tool,
      outcome: completion.outcome,
      durationMs: completion.durationMs,
      summary: completion.summary,
    });
  }

  async said(message: SaidMessage): Promise<void> {
    await this.#say({
      type: 'agent.message',
      message: SessionMessageSchema.parse({
        messageId: message.messageId,
        role: 'agent',
        text: message.text,
        sentAt: message.sentAt,
      }),
    });
  }

  async #say(event: ServerEvent): Promise<void> {
    try {
      await this.#options.events.publish(this.#options.sessionId, this.#options.userId, event);
    } catch (error) {
      this.#options.logger.warn(
        { sessionId: this.#options.sessionId, type: event.type, error: String(error) },
        'a live tool update could not be published, the run carries on without it',
      );
    }
  }
}

export interface DurableProgressOptions {
  records: SessionRecords;
  sessionId: string;
  logger: Logger;
  now?: () => Date;
}

export class DurableProgressReporter implements ActionReporter {
  readonly #options: DurableProgressOptions;

  readonly #now: () => Date;

  constructor(options: DurableProgressOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): Date => new Date());
  }

  async started(invocation: ToolInvocation): Promise<void> {
    await this.#write(0, invocation.summary);
  }

  async output(): Promise<void> {
    await Promise.resolve();
  }

  async completed(completion: ReportedCompletion): Promise<void> {
    await this.#write(completion.step, completion.summary);
  }

  async said(message: SaidMessage): Promise<void> {
    try {
      await this.#options.records.addAgentMessage(
        this.#options.sessionId,
        message.text,
        new Date(message.sentAt),
        message.messageId,
      );
    } catch (error) {
      this.#options.logger.warn(
        { sessionId: this.#options.sessionId, error: String(error) },
        'a note from the agent could not be kept, the person still saw it live',
      );
    }
  }

  async #write(step: number, activity: string): Promise<void> {
    try {
      await this.#options.records.recordProgress(
        this.#options.sessionId,
        { step, currentActivity: activity },
        this.#now(),
      );
    } catch (error) {
      this.#options.logger.warn(
        { sessionId: this.#options.sessionId, error: String(error) },
        'the progress of a run could not be written down, the run carries on without it',
      );
    }
  }
}

export class EveryReporter implements ActionReporter {
  readonly #reporters: readonly ActionReporter[];

  constructor(reporters: readonly ActionReporter[]) {
    this.#reporters = reporters;
  }

  async started(invocation: ToolInvocation): Promise<void> {
    for (const reporter of this.#reporters) {
      await reporter.started(invocation);
    }
  }

  async output(chunk: ReportedChunk): Promise<void> {
    for (const reporter of this.#reporters) {
      await reporter.output(chunk);
    }
  }

  async completed(completion: ReportedCompletion): Promise<void> {
    for (const reporter of this.#reporters) {
      await reporter.completed(completion);
    }
  }

  async said(message: SaidMessage): Promise<void> {
    for (const reporter of this.#reporters) {
      await reporter.said(message);
    }
  }
}
