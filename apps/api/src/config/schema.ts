import { z } from 'zod';

import { LOG_LEVELS } from '../logging/logger.js';

const SESSION_SECRET_PLACEHOLDER = 'replace-with-at-least-32-random-bytes';

const trimmed = z.string().trim();

const optionalText = trimmed.transform((value) => (value === '' ? undefined : value)).optional();

const port = z.coerce.number().int().min(1).max(65_535);

const positiveInt = z.coerce.number().int().positive();

const boolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const httpUrl = trimmed.refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { error: 'must be a valid http or https URL' },
);

const connectionUrl = (protocols: readonly string[]) =>
  trimmed.refine(
    (value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { error: `must be a valid URL using one of: ${protocols.join(', ')}` },
  );

const base64PrivateKey = trimmed.refine(
  (value) => {
    try {
      return /-----BEGIN[^-]*PRIVATE KEY-----/.test(Buffer.from(value, 'base64').toString('utf8'));
    } catch {
      return false;
    }
  },
  { error: 'must be a base64 encoded PEM private key' },
);

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: trimmed.min(1).default('127.0.0.1'),
  API_PORT: port.default(4000),
  WEB_ORIGIN: httpUrl,
  PUBLIC_API_URL: httpUrl,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  MONGODB_URI: connectionUrl(['mongodb:', 'mongodb+srv:']),
  REDIS_URL: connectionUrl(['redis:', 'rediss:']),

  SESSION_SECRET: trimmed
    .min(32, { error: 'must be at least 32 characters' })
    .refine((value) => value !== SESSION_SECRET_PLACEHOLDER, {
      error: 'is still the example placeholder and must be replaced',
    }),
  SESSION_TTL_SECONDS: positiveInt.default(3600),
  OTP_TTL_SECONDS: positiveInt.default(600),
  OTP_MAX_ATTEMPTS: positiveInt.max(20).default(5),
  OTP_REQUEST_LIMIT_PER_HOUR: positiveInt.max(100).default(5),

  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,
  GOOGLE_CALLBACK_URL: httpUrl.optional(),

  GITHUB_APP_ID: optionalText,
  GITHUB_APP_SLUG: optionalText,
  GITHUB_APP_PRIVATE_KEY_BASE64: base64PrivateKey.optional(),
  GITHUB_WEBHOOK_SECRET: optionalText,
  GITHUB_SETUP_CALLBACK_URL: httpUrl.optional(),

  E2B_API_KEY: optionalText,
  SANDBOX_TEMPLATE_ID: optionalText,
  SANDBOX_MAX_SECONDS: positiveInt.max(7200).default(1800),
  SANDBOX_ALLOW_INTERNET: boolean.default(false),

  GROQ_API_KEY: optionalText,
  GEMINI_API_KEY: optionalText,
  DEFAULT_TEXT_MODEL: optionalText,
  DEFAULT_VISION_MODEL: optionalText,

  SMTP_HOST: optionalText,
  SMTP_PORT: port.default(587),
  SMTP_SECURE: boolean.default(false),
  SMTP_USER: optionalText,
  SMTP_PASSWORD: optionalText,
  MAIL_FROM: trimmed.min(1).default('Nimbus <noreply@example.com>'),

  ENABLE_SEMANTIC_SEARCH: boolean.default(false),
  QDRANT_URL: httpUrl.optional(),
  QDRANT_API_KEY: optionalText,

  MAX_ATTACHMENT_BYTES: positiveInt.default(5_242_880),
  MAX_TOOL_OUTPUT_BYTES: positiveInt.default(262_144),
  MAX_AGENT_STEPS: positiveInt.max(200).default(30),
  MAX_CHANGED_FILES: positiveInt.max(500).default(30),
  MAX_DIFF_LINES: positiveInt.max(50_000).default(2000),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type RawEnvironment = z.infer<typeof environmentSchema>;
