import type { LlmProviderName } from '@nimbus/contracts';

export const VERIFY_TIMEOUT_MS = 10_000;

export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export type KeyVerdict = 'valid' | 'rejected' | 'unreachable';

export interface VerifiedKey {
  verdict: KeyVerdict;
  status: number | null;
}

export interface ProviderKeyVerifier {
  verify(provider: LlmProviderName, apiKey: string): Promise<VerifiedKey>;
}

function requestFor(
  _provider: LlmProviderName,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  return { url: GEMINI_MODELS_URL, headers: { 'x-goog-api-key': apiKey } };
}

function verdictFor(status: number): KeyVerdict {
  if (status >= 200 && status < 300) {
    return 'valid';
  }

  if (status === 400 || status === 401 || status === 403) {
    return 'rejected';
  }
  return 'unreachable';
}

export class LiveProviderKeyVerifier implements ProviderKeyVerifier {
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  }

  async verify(provider: LlmProviderName, apiKey: string): Promise<VerifiedKey> {
    const { url, headers } = requestFor(provider, apiKey);
    const stop = AbortSignal.timeout(this.#timeoutMs);

    try {
      const response = await fetch(url, { method: 'GET', headers, signal: stop });
      return { verdict: verdictFor(response.status), status: response.status };
    } catch {
      return { verdict: 'unreachable', status: null };
    }
  }
}

export class AcceptingKeyVerifier implements ProviderKeyVerifier {
  async verify(): Promise<VerifiedKey> {
    return Promise.resolve({ verdict: 'valid', status: 200 });
  }
}
