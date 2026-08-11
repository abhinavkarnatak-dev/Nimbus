import { loadConfig, type AppConfig } from '../config/load.js';
import { minimalEnv, productionEnv } from '../config/env.fixtures.js';
import { createLogger, type Logger } from '../logging/logger.js';

export interface CapturedLog {
  level: string;
  msg?: string;
  [key: string]: unknown;
}

export interface TestLogger {
  logger: Logger;
  lines: CapturedLog[];
}

export function createTestLogger(): TestLogger {
  const lines: CapturedLog[] = [];

  const logger = createLogger({
    level: 'trace',
    environment: 'test',
    destination: {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as CapturedLog);
      },
    },
  });

  return { logger, lines };
}

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ ...minimalEnv(), ...overrides });
}

export function productionConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ ...productionEnv(), ...overrides });
}
