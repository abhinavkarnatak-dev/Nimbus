const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'this-is-not-a-real-key-it-only-exists-so-tests-can-check-the-shape',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

export const VALID_PRIVATE_KEY_PEM = PEM;

export const VALID_PRIVATE_KEY_BASE64 = Buffer.from(PEM, 'utf8').toString('base64');

export function minimalEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'development',
    WEB_ORIGIN: 'http://localhost:5173',
    PUBLIC_API_URL: 'http://localhost:4000',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/nimbus',
    REDIS_URL: 'redis://127.0.0.1:6379',
    SESSION_SECRET: 'z'.repeat(48),
  };
}

export function productionEnv(): Record<string, string | undefined> {
  return {
    ...minimalEnv(),
    NODE_ENV: 'production',
    WEB_ORIGIN: 'https://nimbus.example.com',
    PUBLIC_API_URL: 'https://api.nimbus.example.com',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_CALLBACK_URL: 'https://api.nimbus.example.com/auth/google/callback',
    GITHUB_APP_ID: '123456',
    GITHUB_APP_SLUG: 'nimbus-agent',
    GITHUB_CLIENT_ID: 'Iv23liFakeClientId',
    GITHUB_CLIENT_SECRET: 'fake-github-client-secret',
    GITHUB_APP_PRIVATE_KEY_BASE64: VALID_PRIVATE_KEY_BASE64,
    GITHUB_WEBHOOK_SECRET: 'webhook-secret-value',
    GITHUB_SETUP_CALLBACK_URL: 'https://api.nimbus.example.com/github/setup/callback',
    E2B_API_KEY: 'e2b-api-key',
    SANDBOX_PROVIDER: 'e2b',
    SANDBOX_TEMPLATE_ID: 'nimbus-sandbox',
    GROQ_API_KEY: 'groq-api-key',
    SMTP_HOST: 'smtp.example.com',
  };
}
