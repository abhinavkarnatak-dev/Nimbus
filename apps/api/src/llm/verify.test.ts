import { describe, expect, it } from 'vitest';

import { stubFetch } from './llm.fixtures.js';
import { GEMINI_MODELS_URL, LiveProviderKeyVerifier } from './verify.js';

const GEMINI_KEY = `AIza${'k'.repeat(35)}`;

describe('checking a key against the provider that issued it', () => {
  it('asks Gemini with the header Gemini expects', async () => {
    const stub = stubFetch([{ status: 200, body: { models: [] } }]);

    try {
      const checked = await new LiveProviderKeyVerifier().verify('gemini', GEMINI_KEY);

      expect(checked.verdict).toBe('valid');
      expect(stub.calls[0]?.url).toBe(GEMINI_MODELS_URL);
      expect(stub.calls[0]?.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    } finally {
      stub.restore();
    }
  });

  it('calls a key the provider turned down rejected', async () => {
    for (const status of [400, 401, 403]) {
      const stub = stubFetch([{ status, body: { error: {} } }]);

      try {
        expect((await new LiveProviderKeyVerifier().verify('gemini', GEMINI_KEY)).verdict).toBe(
          'rejected',
        );
      } finally {
        stub.restore();
      }
    }
  });

  it('separates a provider that is down from a key that is wrong', async () => {
    for (const status of [429, 500, 503]) {
      const stub = stubFetch([{ status, body: {} }]);

      try {
        expect((await new LiveProviderKeyVerifier().verify('gemini', GEMINI_KEY)).verdict).toBe(
          'unreachable',
        );
      } finally {
        stub.restore();
      }
    }
  });

  it('treats a network fault as unreachable rather than as a bad key', async () => {
    const stub = stubFetch([{ networkError: true }]);

    try {
      const checked = await new LiveProviderKeyVerifier().verify('gemini', GEMINI_KEY);

      expect(checked.verdict).toBe('unreachable');
      expect(checked.status).toBeNull();
    } finally {
      stub.restore();
    }
  });

  it('gives up rather than hanging when the provider never answers', async () => {
    const stub = stubFetch([{ delayMs: 200, status: 200, body: {} }]);

    try {
      expect(
        (await new LiveProviderKeyVerifier({ timeoutMs: 20 }).verify('gemini', GEMINI_KEY)).verdict,
      ).toBe('unreachable');
    } finally {
      stub.restore();
    }
  });

  it('never sends the key anywhere but the provider it belongs to', async () => {
    const stub = stubFetch([{ status: 200, body: {} }]);

    try {
      await new LiveProviderKeyVerifier().verify('gemini', GEMINI_KEY);

      expect(stub.calls[0]?.url.startsWith('https://generativelanguage.googleapis.com/')).toBe(
        true,
      );
      expect(JSON.stringify(stub.calls[0]?.body)).not.toContain(GEMINI_KEY);
    } finally {
      stub.restore();
    }
  });
});
