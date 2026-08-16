import type { ServerEvent, ToolInvocation } from '@nimbus/contracts';

import type {
  ActionReporter,
  ReportedChunk,
  ReportedCompletion,
} from '../agent/execute/reporter.js';
import type { EventPublisher } from '../events/publisher.js';
import type { Logger } from '../logging/logger.js';

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
