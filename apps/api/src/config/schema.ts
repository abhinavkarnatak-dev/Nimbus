import { z } from 'zod';

import { LOG_LEVELS } from '../logging/logger.js';
import { DEFAULT_LIMITS, HARD_LIMITS } from './limits.js';

const SESSION_SECRET_PLACEHOLDER = 'replace-with-at-least-32-random-bytes';

export const SESSION_TTL_MAX_SECONDS = 31_536_000;

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
  SESSION_TTL_SECONDS: positiveInt.max(SESSION_TTL_MAX_SECONDS).default(604_800),
  SESSION_ABSOLUTE_TTL_SECONDS: positiveInt.max(SESSION_TTL_MAX_SECONDS).default(2_592_000),
  OTP_TTL_SECONDS: positiveInt.default(600),
  OTP_MAX_ATTEMPTS: positiveInt.max(20).default(5),
  OTP_REQUEST_LIMIT_PER_HOUR: positiveInt.max(100).default(5),

  AGENT_SESSIONS_ENABLED: boolean.default(true),
  SESSION_START_LIMIT_PER_HOUR: positiveInt.max(500).default(20),
  SESSION_MESSAGE_LIMIT_PER_MINUTE: positiveInt.max(600).default(20),

  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,
  GOOGLE_CALLBACK_URL: httpUrl.optional(),

  GITHUB_APP_ID: optionalText,
  GITHUB_APP_SLUG: optionalText,
  GITHUB_CLIENT_ID: optionalText,
  GITHUB_CLIENT_SECRET: optionalText,
  GITHUB_APP_PRIVATE_KEY_BASE64: base64PrivateKey.optional(),
  GITHUB_WEBHOOK_SECRET: optionalText,
  GITHUB_SETUP_CALLBACK_URL: httpUrl.optional(),

  E2B_API_KEY: optionalText,
  SANDBOX_PROVIDER: z.enum(['fake', 'e2b']).default('fake'),
  SANDBOX_TEMPLATE_ID: optionalText,
  SANDBOX_MAX_SECONDS: positiveInt
    .max(HARD_LIMITS.maxSandboxSeconds)
    .default(DEFAULT_LIMITS.maxSandboxSeconds),
  SANDBOX_ALLOW_INTERNET: boolean.default(false),

  S3_ENDPOINT: httpUrl.optional(),
  S3_REGION: trimmed.min(1).default('auto'),
  S3_BUCKET: optionalText,
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,

  DEFAULT_TEXT_MODEL: optionalText,
  DEFAULT_VISION_MODEL: optionalText,

  RESEND_API_KEY: optionalText,

  SMTP_HOST: optionalText,
  SMTP_PORT: port.default(587),
  SMTP_SECURE: boolean.default(false),
  SMTP_USER: optionalText,
  SMTP_PASSWORD: optionalText,
  MAIL_FROM: trimmed.min(1).default('Nimbus <noreply@example.com>'),

  ENABLE_SEMANTIC_SEARCH: boolean.default(false),
  QDRANT_URL: httpUrl.optional(),
  QDRANT_API_KEY: optionalText,

  MAX_ATTACHMENT_BYTES: positiveInt
    .max(HARD_LIMITS.maxAttachmentBytes)
    .default(DEFAULT_LIMITS.maxAttachmentBytes),
  MAX_TOOL_OUTPUT_BYTES: positiveInt
    .max(HARD_LIMITS.maxToolOutputBytes)
    .default(DEFAULT_LIMITS.maxToolOutputBytes),
  MAX_AGENT_STEPS: positiveInt.max(HARD_LIMITS.maxAgentSteps).default(DEFAULT_LIMITS.maxAgentSteps),
  MAX_CHANGED_FILES: positiveInt
    .max(HARD_LIMITS.maxChangedFiles)
    .default(DEFAULT_LIMITS.maxChangedFiles),
  MAX_DIFF_LINES: positiveInt.max(HARD_LIMITS.maxDiffLines).default(DEFAULT_LIMITS.maxDiffLines),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type RawEnvironment = z.infer<typeof environmentSchema>;
