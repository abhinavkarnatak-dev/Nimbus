import type { z } from 'zod';

import type { LogLevel } from '../logging/logger.js';
import { environmentSchema, type RawEnvironment } from './schema.js';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface GitHubConfig {
  appId: string;
  appSlug: string;
  privateKeyPem: string;
  webhookSecret: string;
  setupCallbackUrl: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
}

export interface SandboxConfig {
  apiKey?: string;
  templateId?: string;
  maxSeconds: number;
  allowInternet: boolean;
}

export interface LlmConfig {
  groqApiKey?: string;
  geminiApiKey?: string;
  defaultTextModel?: string;
  defaultVisionModel?: string;
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
}

export interface AppConfig {
  env: RawEnvironment['NODE_ENV'];
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  api: { host: string; port: number; publicUrl: string; webOrigin: string };
  mongo: { uri: string };
  redis: { url: string };
  session: { secret: string; ttlSeconds: number };
  otp: { ttlSeconds: number; maxAttempts: number; requestLimitPerHour: number };
  google: GoogleConfig | null;
  github: GitHubConfig | null;
  sandbox: SandboxConfig;
  llm: LlmConfig;
  smtp: SmtpConfig | null;
  mail: { from: string };
  features: { semanticSearch: boolean };
  qdrant: QdrantConfig | null;
  limits: {
    maxAttachmentBytes: number;
    maxToolOutputBytes: number;
    maxAgentSteps: number;
    maxChangedFiles: number;
    maxDiffLines: number;
  };
  logging: { level: LogLevel };
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Configuration is invalid:\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.length > 0 ? issue.path.join('.') : '<root>';

  switch (issue.code) {
    case 'invalid_type':
      return `${field}: is required`;
    case 'too_small':
      return `${field}: is shorter or smaller than the allowed minimum`;
    case 'too_big':
      return `${field}: is longer or larger than the allowed maximum`;
    case 'invalid_value':
      return `${field}: is not one of the allowed values`;
    case 'unrecognized_keys':
      return `${field}: contains unknown settings`;
    default:
      return `${field}: ${issue.message}`;
  }
}

function describeIssues(error: z.ZodError): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const issue of error.issues) {
    const described = describeIssue(issue);
    if (!seen.has(described)) {
      seen.add(described);
      issues.push(described);
    }
  }
  return issues.sort((a, b) => a.localeCompare(b));
}

function buildGoogle(raw: RawEnvironment): GoogleConfig | null {
  if (
    raw.GOOGLE_CLIENT_ID === undefined ||
    raw.GOOGLE_CLIENT_SECRET === undefined ||
    raw.GOOGLE_CALLBACK_URL === undefined
  ) {
    return null;
  }
  return {
    clientId: raw.GOOGLE_CLIENT_ID,
    clientSecret: raw.GOOGLE_CLIENT_SECRET,
    callbackUrl: raw.GOOGLE_CALLBACK_URL,
  };
}

function buildGitHub(raw: RawEnvironment): GitHubConfig | null {
  if (
    raw.GITHUB_APP_ID === undefined ||
    raw.GITHUB_APP_SLUG === undefined ||
    raw.GITHUB_APP_PRIVATE_KEY_BASE64 === undefined ||
    raw.GITHUB_WEBHOOK_SECRET === undefined ||
    raw.GITHUB_SETUP_CALLBACK_URL === undefined
  ) {
    return null;
  }
  return {
    appId: raw.GITHUB_APP_ID,
    appSlug: raw.GITHUB_APP_SLUG,
    privateKeyPem: Buffer.from(raw.GITHUB_APP_PRIVATE_KEY_BASE64, 'base64').toString('utf8'),
    webhookSecret: raw.GITHUB_WEBHOOK_SECRET,
    setupCallbackUrl: raw.GITHUB_SETUP_CALLBACK_URL,
  };
}

function buildSmtp(raw: RawEnvironment): SmtpConfig | null {
  if (raw.SMTP_HOST === undefined) {
    return null;
  }
  return {
    host: raw.SMTP_HOST,
    port: raw.SMTP_PORT,
    secure: raw.SMTP_SECURE,
    ...(raw.SMTP_USER === undefined ? {} : { user: raw.SMTP_USER }),
    ...(raw.SMTP_PASSWORD === undefined ? {} : { password: raw.SMTP_PASSWORD }),
  };
}

function buildQdrant(raw: RawEnvironment): QdrantConfig | null {
  if (raw.QDRANT_URL === undefined) {
    return null;
  }
  return {
    url: raw.QDRANT_URL,
    ...(raw.QDRANT_API_KEY === undefined ? {} : { apiKey: raw.QDRANT_API_KEY }),
  };
}

function productionIssues(config: AppConfig): string[] {
  if (!config.isProduction) {
    return [];
  }

  const issues: string[] = [];

  if (config.google === null) {
    issues.push(
      'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL: all required in production',
    );
  }
  if (config.github === null) {
    issues.push(
      'GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY_BASE64, GITHUB_WEBHOOK_SECRET, GITHUB_SETUP_CALLBACK_URL: all required in production',
    );
  }
  if (config.smtp === null) {
    issues.push('SMTP_HOST: required in production');
  }
  if (config.sandbox.apiKey === undefined || config.sandbox.templateId === undefined) {
    issues.push('E2B_API_KEY, SANDBOX_TEMPLATE_ID: both required in production');
  }
  if (config.llm.groqApiKey === undefined) {
    issues.push('GROQ_API_KEY: required in production');
  }
  if (config.sandbox.allowInternet) {
    issues.push('SANDBOX_ALLOW_INTERNET: must be false in production');
  }
  if (config.features.semanticSearch && config.qdrant === null) {
    issues.push('QDRANT_URL: required when ENABLE_SEMANTIC_SEARCH is true');
  }
  if (!config.api.publicUrl.startsWith('https://')) {
    issues.push('PUBLIC_API_URL: must use https in production');
  }
  if (!config.api.webOrigin.startsWith('https://')) {
    issues.push('WEB_ORIGIN: must use https in production');
  }

  return issues;
}

function toAppConfig(raw: RawEnvironment): AppConfig {
  return {
    env: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    isDevelopment: raw.NODE_ENV === 'development',
    isTest: raw.NODE_ENV === 'test',
    api: {
      host: raw.API_HOST,
      port: raw.API_PORT,
      publicUrl: raw.PUBLIC_API_URL,
      webOrigin: raw.WEB_ORIGIN,
    },
    mongo: { uri: raw.MONGODB_URI },
    redis: { url: raw.REDIS_URL },
    session: { secret: raw.SESSION_SECRET, ttlSeconds: raw.SESSION_TTL_SECONDS },
    otp: {
      ttlSeconds: raw.OTP_TTL_SECONDS,
      maxAttempts: raw.OTP_MAX_ATTEMPTS,
      requestLimitPerHour: raw.OTP_REQUEST_LIMIT_PER_HOUR,
    },
    google: buildGoogle(raw),
    github: buildGitHub(raw),
    sandbox: {
      ...(raw.E2B_API_KEY === undefined ? {} : { apiKey: raw.E2B_API_KEY }),
      ...(raw.SANDBOX_TEMPLATE_ID === undefined ? {} : { templateId: raw.SANDBOX_TEMPLATE_ID }),
      maxSeconds: raw.SANDBOX_MAX_SECONDS,
      allowInternet: raw.SANDBOX_ALLOW_INTERNET,
    },
    llm: {
      ...(raw.GROQ_API_KEY === undefined ? {} : { groqApiKey: raw.GROQ_API_KEY }),
      ...(raw.GEMINI_API_KEY === undefined ? {} : { geminiApiKey: raw.GEMINI_API_KEY }),
      ...(raw.DEFAULT_TEXT_MODEL === undefined ? {} : { defaultTextModel: raw.DEFAULT_TEXT_MODEL }),
      ...(raw.DEFAULT_VISION_MODEL === undefined
        ? {}
        : { defaultVisionModel: raw.DEFAULT_VISION_MODEL }),
    },
    smtp: buildSmtp(raw),
    mail: { from: raw.MAIL_FROM },
    features: { semanticSearch: raw.ENABLE_SEMANTIC_SEARCH },
    qdrant: buildQdrant(raw),
    limits: {
      maxAttachmentBytes: raw.MAX_ATTACHMENT_BYTES,
      maxToolOutputBytes: raw.MAX_TOOL_OUTPUT_BYTES,
      maxAgentSteps: raw.MAX_AGENT_STEPS,
      maxChangedFiles: raw.MAX_CHANGED_FILES,
      maxDiffLines: raw.MAX_DIFF_LINES,
    },
    logging: { level: raw.LOG_LEVEL },
  };
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(source);

  if (!parsed.success) {
    throw new ConfigError(describeIssues(parsed.error));
  }

  const config = toAppConfig(parsed.data);
  const issues = productionIssues(config);

  if (issues.length > 0) {
    throw new ConfigError(issues.sort((a, b) => a.localeCompare(b)));
  }

  return Object.freeze(config);
}
