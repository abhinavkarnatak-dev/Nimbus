import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { redactValue, redactString } from './redact.js';
import { getRequestContext } from './request-context.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerConfig {
  level: LogLevel;
  environment: string;
  destination?: DestinationStream;
}

function buildOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level,
    base: { service: 'nimbus-api', environment: config.environment },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => redactValue(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const cleaned = args.map((arg) => (typeof arg === 'string' ? redactString(arg) : arg));
        method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
    mixin() {
      const context = getRequestContext();
      if (context === undefined) {
        return {};
      }
      return {
        requestId: context.requestId,
        ...(context.userId === undefined ? {} : { userId: context.userId }),
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      };
    },
  };
}

export function createLogger(config: LoggerConfig): Logger {
  const options = buildOptions(config);
  return config.destination === undefined ? pino(options) : pino(options, config.destination);
}

export type { Logger };
