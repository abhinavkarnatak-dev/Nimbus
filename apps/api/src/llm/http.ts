import type { LlmProviderName } from '@nimbus/contracts';

import type { Logger } from '../logging/logger.js';
import { redactSecrets } from '../logging/redact.js';
import { LlmError, type LlmErrorOptions } from './errors.js';
import { LLM_LIMITS } from './limits.js';
import { codeForStatus, parseRetryAfter, shouldRetry, sleep, waitBeforeRetry } from './retry.js';

export interface ProviderRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  maxAttempts?: number;
  random?: () => number;
}

export interface ProviderResponse {
  body: unknown;
  attempts: number;
  durationMs: number;
}

export interface RunnerOptions {
  provider: LlmProviderName;
  model: string;
  logger: Logger;
}

function safeDetail(body: unknown): string | undefined {
  const message = extractMessage(body);

  if (message === null) {
    return undefined;
  }
  return redactSecrets(message).slice(0, LLM_LIMITS.errorDetailMaxChars);
}

function extractMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const record = body as { error?: unknown; message?: unknown };

  if (typeof record.message === 'string') {
    return record.message;
  }

  if (typeof record.error === 'string') {
    return record.error;
  }

  if (typeof record.error === 'object' && record.error !== null) {
    const inner = (record.error as { message?: unknown }).message;
    return typeof inner === 'string' ? inner : null;
  }
  return null;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text === '') {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, LLM_LIMITS.errorDetailMaxChars) };
  }
}

async function once(
  request: ProviderRequest,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal =
    request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

  let response: Response;

  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    if (request.signal?.aborted === true) {
      throw new LlmError('LLM_CANCELLED', 'That request was cancelled.', { cause: error });
    }

    if (timeout.aborted) {
      throw new LlmError('LLM_TIMED_OUT', 'The model took too long to answer.', { cause: error });
    }
    throw new LlmError('LLM_UNAVAILABLE', 'The model could not be reached.', { cause: error });
  }

  return { status: response.status, headers: response.headers, body: await readBody(response) };
}

export class ProviderRunner {
  private readonly provider: LlmProviderName;

  private readonly model: string;

  private readonly logger: Logger;

  constructor(options: RunnerOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.logger = options.logger;
  }

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const maxAttempts = request.maxAttempts ?? LLM_LIMITS.maxAttempts;
    const started = Date.now();
    let attempt = 0;

    for (;;) {
      attempt += 1;

      try {
        const result = await once(request);

        this.logger.debug(
          {
            provider: this.provider,
            model: this.model,
            attempt,
            status: result.status,
            durationMs: Date.now() - started,
          },
          'model provider answered',
        );

        if (result.status >= 200 && result.status < 300) {
          return { body: result.body, attempts: attempt, durationMs: Date.now() - started };
        }

        const detail = safeDetail(result.body);
        const retryAfterMs = parseRetryAfter(result.headers.get('retry-after'), Date.now());
        const options: LlmErrorOptions = { status: result.status };

        if (detail !== undefined) {
          options.detail = detail;
        }

        if (retryAfterMs !== null) {
          options.retryAfterMs = retryAfterMs;
        }

        throw new LlmError(
          codeForStatus(result.status),
          'The model provider refused the request.',
          options,
        );
      } catch (error) {
        if (!shouldRetry(error, attempt, maxAttempts)) {
          throw error;
        }

        const waitMs = waitBeforeRetry(error as LlmError, attempt, request.random);

        this.logger.warn(
          {
            provider: this.provider,
            model: this.model,
            attempt,
            code: (error as LlmError).code,
            status: (error as LlmError).status,
            waitMs,
          },
          'model provider failed, trying again',
        );

        await sleep(waitMs, request.signal);
      }
    }
  }
}
