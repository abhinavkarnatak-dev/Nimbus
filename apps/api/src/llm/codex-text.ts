import { Codex, type CodexOptions, type Thread, type ThreadOptions, type Usage } from '@openai/codex-sdk';
import type { CallReport } from '@nimbus/contracts';

import type { Logger } from '../logging/logger.js';
import { LlmError } from './errors.js';
import { DEFAULT_CODEX_TEXT_MODEL } from './models.js';
import {
  buildReport,
  type CompleteRequest,
  type CompleteResult,
  type Message,
  type StructuredRequest,
  type StructuredResult,
  type TextProvider,
} from './provider.js';
import { describeIssues, issueCodes, parseJson } from './json.js';

export type CodexThread = Pick<Thread, 'run' | 'runStreamed'>;

export interface CodexClient {
  startThread(options?: ThreadOptions): CodexThread;
}

export interface CodexTextOptions {
  client?: CodexClient;
  logger: Logger;
  model?: string;
  workingDirectory?: string;
  codexHome?: string;
  codexPathOverride?: string;
}

function promptFor(messages: readonly Message[]): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
}

function report(model: string, usage: Usage | null, durationMs: number): CallReport {
  return buildReport({
    provider: 'codex',
    model,
    usage: {
      promptTokens: usage?.input_tokens ?? 0,
      completionTokens: usage?.output_tokens ?? 0,
      reasoningTokens: usage?.reasoning_output_tokens ?? 0,
      totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
    attempts: 1,
    durationMs,
  });
}

export class CodexTextProvider implements TextProvider {
  readonly name = 'codex' as const;
  readonly real = true;
  readonly defaultModel: string;
  readonly #client: CodexClient;
  readonly #logger: Logger;
  readonly #workingDirectory: string | undefined;

  constructor(options: CodexTextOptions) {
    this.#logger = options.logger;
    this.defaultModel = options.model ?? DEFAULT_CODEX_TEXT_MODEL;
    this.#workingDirectory = options.workingDirectory;
    if (options.client !== undefined) {
      this.#client = options.client;
    } else {
      const codexOptions: CodexOptions = {
        ...(options.codexPathOverride === undefined
          ? {}
          : { codexPathOverride: options.codexPathOverride }),
        ...(options.codexHome === undefined
          ? {}
          : { env: { ...process.env, CODEX_HOME: options.codexHome } }),
      };
      this.#client = new Codex(codexOptions);
    }
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const model = request.model ?? this.defaultModel;
    const started = Date.now();
    const turn = await this.#run(model, promptFor(request.messages), request.signal);
    return { text: turn.finalResponse, report: report(model, turn.usage, Date.now() - started) };
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = request.model ?? this.defaultModel;
    const started = Date.now();
    const turn = await this.#run(
      model,
      promptFor(request.messages),
      request.signal,
      request.jsonSchema,
    );
    const parsed = parseJson(turn.finalResponse);
    if (parsed === null) {
      throw new LlmError('LLM_SCHEMA_REFUSED', 'Codex did not return valid JSON.');
    }
    const checked = request.schema.safeParse(parsed);
    if (!checked.success) {
      const detail = describeIssues(checked.error);
      this.#logger.warn(
        { provider: this.name, model, issueCodes: issueCodes(checked.error) },
        'Codex returned an invalid structured answer',
      );
      throw new LlmError('LLM_SCHEMA_REFUSED', 'Codex did not return the required shape.', {
        detail,
      });
    }
    return { value: checked.data, report: report(model, turn.usage, Date.now() - started) };
  }

  async #run(
    model: string,
    prompt: string,
    signal: AbortSignal | undefined,
    outputSchema?: unknown,
  ) {
    const thread = this.#client.startThread({
      model,
      ...(this.#workingDirectory === undefined ? {} : { workingDirectory: this.#workingDirectory }),
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    });
    const turn = await thread.run(prompt, {
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(signal === undefined ? {} : { signal }),
    });
    return turn;
  }
}
