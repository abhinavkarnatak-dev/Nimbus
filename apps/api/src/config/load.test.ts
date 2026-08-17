import { describe, expect, it } from 'vitest';

import {
  minimalEnv,
  productionEnv,
  VALID_PRIVATE_KEY_BASE64,
  VALID_PRIVATE_KEY_PEM,
} from './env.fixtures.js';
import { ConfigError, loadConfig } from './load.js';

const expectConfigError = (env: Record<string, string | undefined>): ConfigError => {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
};

describe('valid configuration', () => {
  it('loads with only the required settings and applies defaults', () => {
    const config = loadConfig(minimalEnv());

    expect(config.env).toBe('development');
    expect(config.isDevelopment).toBe(true);
    expect(config.isProduction).toBe(false);
    expect(config.api.host).toBe('127.0.0.1');
    expect(config.api.port).toBe(4000);
    expect(config.session.ttlSeconds).toBe(3600);
    expect(config.limits.maxAgentSteps).toBe(30);
    expect(config.logging.level).toBe('info');
  });

  it('converts numeric settings from text to numbers', () => {
    const config = loadConfig({ ...minimalEnv(), API_PORT: '8080', MAX_DIFF_LINES: '500' });

    expect(config.api.port).toBe(8080);
    expect(config.limits.maxDiffLines).toBe(500);
  });

  it('converts boolean settings from text', () => {
    expect(
      loadConfig({ ...minimalEnv(), ENABLE_SEMANTIC_SEARCH: 'true' }).features.semanticSearch,
    ).toBe(true);
    expect(
      loadConfig({ ...minimalEnv(), ENABLE_SEMANTIC_SEARCH: '1' }).features.semanticSearch,
    ).toBe(true);
    expect(
      loadConfig({ ...minimalEnv(), ENABLE_SEMANTIC_SEARCH: 'false' }).features.semanticSearch,
    ).toBe(false);
  });

  it('leaves optional provider groups null when not configured', () => {
    const config = loadConfig(minimalEnv());

    expect(config.google).toBeNull();
    expect(config.github).toBeNull();
    expect(config.smtp).toBeNull();
    expect(config.qdrant).toBeNull();
  });

  it('decodes the GitHub private key from base64 into a PEM', () => {
    const config = loadConfig({
      ...minimalEnv(),
      GITHUB_APP_ID: '123456',
      GITHUB_APP_SLUG: 'nimbus-agent',
      GITHUB_CLIENT_ID: 'Iv23liFakeClientId',
      GITHUB_CLIENT_SECRET: 'fake-client-secret',
      GITHUB_APP_PRIVATE_KEY_BASE64: VALID_PRIVATE_KEY_BASE64,
      GITHUB_WEBHOOK_SECRET: 'webhook-secret',
      GITHUB_SETUP_CALLBACK_URL: 'http://localhost:4000/github/setup/callback',
    });

    expect(config.github?.privateKeyPem).toBe(VALID_PRIVATE_KEY_PEM);
  });

  it('leaves GitHub unconfigured when the oauth client credentials are missing', () => {
    const config = loadConfig({
      ...minimalEnv(),
      GITHUB_APP_ID: '123456',
      GITHUB_APP_SLUG: 'nimbus-agent',
      GITHUB_APP_PRIVATE_KEY_BASE64: VALID_PRIVATE_KEY_BASE64,
      GITHUB_WEBHOOK_SECRET: 'webhook-secret',
      GITHUB_SETUP_CALLBACK_URL: 'http://localhost:4000/github/setup/callback',
    });

    expect(config.github).toBeNull();
  });

  it('returns a frozen object so nothing can change settings at runtime', () => {
    expect(Object.isFrozen(loadConfig(minimalEnv()))).toBe(true);
  });

  it('treats blank optional values as absent rather than empty text', () => {
    const config = loadConfig({
      ...minimalEnv(),
      DEFAULT_TEXT_MODEL: '   ',
      SANDBOX_TEMPLATE_ID: '',
    });

    expect(config.llm.defaultTextModel).toBeUndefined();
    expect(config.sandbox.templateId).toBeUndefined();
  });
});

describe('invalid configuration', () => {
  it('reports every missing required setting at once', () => {
    const error = expectConfigError({ NODE_ENV: 'development' });

    expect(error.issues).toContain('WEB_ORIGIN: is required');
    expect(error.issues).toContain('MONGODB_URI: is required');
    expect(error.issues).toContain('REDIS_URL: is required');
    expect(error.issues).toContain('SESSION_SECRET: is required');
    expect(error.issues.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects a session secret that is too short', () => {
    const error = expectConfigError({ ...minimalEnv(), SESSION_SECRET: 'tooshort' });

    expect(error.issues.join('\n')).toContain('SESSION_SECRET');
  });

  it('rejects the example placeholder session secret', () => {
    const error = expectConfigError({
      ...minimalEnv(),
      SESSION_SECRET: 'replace-with-at-least-32-random-bytes',
    });

    expect(error.issues.join('\n')).toContain('still the example placeholder');
  });

  it('rejects an out of range port and a non-numeric port', () => {
    expect(expectConfigError({ ...minimalEnv(), API_PORT: '70000' }).issues.join()).toContain(
      'API_PORT',
    );
    expect(expectConfigError({ ...minimalEnv(), API_PORT: 'abc' }).issues.join()).toContain(
      'API_PORT',
    );
  });

  it('rejects a URL with the wrong protocol', () => {
    expect(
      expectConfigError({ ...minimalEnv(), MONGODB_URI: 'http://127.0.0.1:27017' }).issues.join(),
    ).toContain('MONGODB_URI');
    expect(
      expectConfigError({ ...minimalEnv(), WEB_ORIGIN: 'ftp://localhost' }).issues.join(),
    ).toContain('WEB_ORIGIN');
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(expectConfigError({ ...minimalEnv(), NODE_ENV: 'staging' }).issues.join()).toContain(
      'NODE_ENV',
    );
  });

  it('rejects a GitHub key that is not a base64 encoded PEM', () => {
    const error = expectConfigError({
      ...minimalEnv(),
      GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from('not a key', 'utf8').toString('base64'),
    });

    expect(error.issues.join()).toContain('GITHUB_APP_PRIVATE_KEY_BASE64');
  });
});

describe('errors never leak secret values', () => {
  const SECRET = 'SuperSecretPassword123';

  it('does not include a password from a malformed database URL', () => {
    const error = expectConfigError({
      ...minimalEnv(),
      MONGODB_URI: `not-a-url://admin:${SECRET}@cluster.example.com/nimbus`,
    });

    expect(error.message).not.toContain(SECRET);
    expect(error.issues.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(error.issues)).not.toContain(SECRET);
  });

  it('does not include a rejected session secret', () => {
    const error = expectConfigError({ ...minimalEnv(), SESSION_SECRET: SECRET });

    expect(error.message).not.toContain(SECRET);
  });

  it('does not include a rejected private key', () => {
    const error = expectConfigError({
      ...minimalEnv(),
      GITHUB_APP_PRIVATE_KEY_BASE64: SECRET,
    });

    expect(error.message).not.toContain(SECRET);
  });

  it('does not include a rejected enum value', () => {
    const error = expectConfigError({ ...minimalEnv(), NODE_ENV: SECRET });

    expect(error.message).not.toContain(SECRET);
  });

  it('names the setting that is wrong even though it hides the value', () => {
    const error = expectConfigError({ ...minimalEnv(), SESSION_SECRET: SECRET });

    expect(error.message).toContain('SESSION_SECRET');
    expect(error.message).toContain('Configuration is invalid');
  });
});

describe('production rules', () => {
  it('accepts a fully configured production environment', () => {
    const config = loadConfig(productionEnv());

    expect(config.isProduction).toBe(true);
    expect(config.github).not.toBeNull();
    expect(config.google).not.toBeNull();
  });

  it('refuses to start in production without the credentials the server itself holds', () => {
    const error = expectConfigError({
      ...minimalEnv(),
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://nimbus.example.com',
      PUBLIC_API_URL: 'https://api.nimbus.example.com',
    });

    const joined = error.issues.join('\n');
    expect(joined).toContain('GITHUB_APP_ID');
    expect(joined).toContain('GOOGLE_CLIENT_ID');
    expect(joined).toContain('E2B_API_KEY');
    expect(joined).toContain('SMTP_HOST');
    expect(joined).not.toContain('GROQ_API_KEY');
    expect(joined).not.toContain('GEMINI_API_KEY');
  });

  it('refuses sandbox internet access in production', () => {
    const error = expectConfigError({ ...productionEnv(), SANDBOX_ALLOW_INTERNET: 'true' });

    expect(error.issues.join()).toContain('SANDBOX_ALLOW_INTERNET');
  });

  it('allows sandbox internet access outside production', () => {
    expect(
      loadConfig({ ...minimalEnv(), SANDBOX_ALLOW_INTERNET: 'true' }).sandbox.allowInternet,
    ).toBe(true);
  });

  it('uses the fake sandbox provider unless told otherwise', () => {
    expect(loadConfig(minimalEnv()).sandbox.provider).toBe('fake');
  });

  it('accepts the real sandbox provider', () => {
    expect(loadConfig({ ...minimalEnv(), SANDBOX_PROVIDER: 'e2b' }).sandbox.provider).toBe('e2b');
  });

  it('refuses a sandbox provider nobody wrote', () => {
    expect(() => loadConfig({ ...minimalEnv(), SANDBOX_PROVIDER: 'docker' })).toThrow();
  });

  it('refuses the fake sandbox provider in production', () => {
    const error = expectConfigError({ ...productionEnv(), SANDBOX_PROVIDER: 'fake' });

    expect(error.issues.join()).toContain('SANDBOX_PROVIDER');
  });

  it('requires https for public URLs in production', () => {
    const error = expectConfigError({
      ...productionEnv(),
      PUBLIC_API_URL: 'http://api.example.com',
    });

    expect(error.issues.join()).toContain('PUBLIC_API_URL');
  });

  it('requires Qdrant when semantic search is switched on', () => {
    const error = expectConfigError({ ...productionEnv(), ENABLE_SEMANTIC_SEARCH: 'true' });

    expect(error.issues.join()).toContain('QDRANT_URL');
  });
});

describe('the models a plan can reach', () => {
  it('never asks the server for a provider key, because every key belongs to an account', () => {
    const config = loadConfig(productionEnv());

    expect(Object.keys(config.llm)).not.toContain('geminiApiKey');
    expect(Object.keys(config.llm)).not.toContain('groqApiKey');
  });

  it('refuses an unknown default text model in every environment', () => {
    const development = expectConfigError({ ...minimalEnv(), DEFAULT_TEXT_MODEL: 'made-up-model' });
    const production = expectConfigError({
      ...productionEnv(),
      DEFAULT_TEXT_MODEL: 'made-up-model',
    });

    expect(development.issues.join()).toContain('DEFAULT_TEXT_MODEL');
    expect(development.issues.join()).toContain('does not know about');
    expect(production.issues.join()).toContain('DEFAULT_TEXT_MODEL');
  });

  it('refuses a vision model that cannot look at images', () => {
    const error = expectConfigError({
      ...productionEnv(),
      DEFAULT_VISION_MODEL: 'openai/gpt-oss-120b',
    });

    expect(error.issues.join()).toContain('DEFAULT_VISION_MODEL');
  });
});
