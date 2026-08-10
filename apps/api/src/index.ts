import { ConfigError, getConfig } from './config/index.js';
import { createLogger, type Logger } from './logging/logger.js';
import { startApi } from './server.js';

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
const FLUSH_TIMEOUT_MS = 1_000;

function exitAfterFlush(logger: Logger, code: number): void {
  const fallback = setTimeout(() => {
    process.exit(code);
  }, FLUSH_TIMEOUT_MS);
  fallback.unref();

  logger.flush(() => {
    process.exit(code);
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger({ level: config.logging.level, environment: config.env });

  const api = await startApi({ config, logger });

  let stopping = false;

  const stop = (reason: string, exitCode: number): void => {
    if (stopping) {
      logger.warn({ reason }, 'Already shutting down, exiting immediately');
      process.exit(1);
    }
    stopping = true;

    api.shutdown(reason).then(
      () => {
        exitAfterFlush(logger, exitCode);
      },
      (error: unknown) => {
        logger.error({ err: error }, 'Shutdown failed');
        exitAfterFlush(logger, 1);
      },
    );
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      stop(signal, 0);
    });
  }

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    stop('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled rejection');
    stop('unhandledRejection', 1);
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`Nimbus API failed to start: ${String(error)}\n`);
  process.exit(1);
});
