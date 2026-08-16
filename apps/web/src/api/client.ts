import type { z } from 'zod';

import { ApiError, NetworkError, readErrorBody } from './errors.js';

export const CSRF_HEADER = 'x-csrf-token';

export const MUTATING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface CsrfSource {
  token(): string | null;
}

export interface ApiClientOptions {
  baseUrl: string;
  csrf: CsrfSource;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions<T> {
  method?: string;
  path: string;
  body?: unknown;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
}

export class ApiClient {
  readonly #baseUrl: string;

  readonly #csrf: CsrfSource;

  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#csrf = options.csrf;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async send<T>(options: RequestOptions<T>): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase();
    const headers = new Headers({ accept: 'application/json' });

    if (options.body !== undefined) {
      headers.set('content-type', 'application/json');
    }

    if (MUTATING_METHODS.includes(method)) {
      const token = this.#csrf.token();

      if (token !== null) {
        headers.set(CSRF_HEADER, token);
      }
    }

    let response: Response;

    try {
      response = await this.#fetch(`${this.#baseUrl}${options.path}`, {
        method,
        headers,
        credentials: 'include',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      throw new NetworkError(error);
    }

    const payload = await readJson(response);

    if (!response.ok) {
      throw readErrorBody(response.status, payload);
    }

    const parsed = options.schema.safeParse(payload);

    if (!parsed.success) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        message: 'Nimbus sent something this page could not read.',
        status: response.status,
      });
    }

    return parsed.data;
  }

  async get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    return this.send({ path, schema, ...(signal === undefined ? {} : { signal }) });
  }

  async post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.send({
      method: 'POST',
      path,
      body,
      schema,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
