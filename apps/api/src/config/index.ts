import { loadConfig, type AppConfig } from './load.js';

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}

export { loadConfig, ConfigError } from './load.js';
export type {
  AppConfig,
  GitHubConfig,
  GoogleConfig,
  LlmConfig,
  QdrantConfig,
  SandboxConfig,
  SmtpConfig,
} from './load.js';
