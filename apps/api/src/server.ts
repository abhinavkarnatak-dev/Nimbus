import { createServer, type Server } from 'node:http';

import type { Express } from 'express';

import { createApp } from './app.js';
import type { AppConfig } from './config/load.js';
import { closeDatabase, connectDatabase } from './db/client.js';
import { ensureDatabaseSchema } from './db/bootstrap.js';
import { GoogleIdentityAdapter } from './auth/google-identity.js';
import { GoogleService } from './auth/google-service.js';
import { OtpService } from './auth/otp-service.js';
import { SessionService } from './auth/session-service.js';
import { createMailService, type MailService } from './email/mail-service.js';
import { OctokitGitHubDirectory } from './github/directory.js';
import { InstallationService } from './github/installation-service.js';
import { GitHubAppTokenProvider } from './github/token-provider.js';
import { createAttachSession } from './http/middleware/session.js';
import { createAuthRouter } from './http/routes/auth.js';
import { createGitHubRouter } from './http/routes/github.js';
import type { DependencyCheck } from './http/routes/health.js';
import type { Logger } from './logging/logger.js';
import { closeRedis, connectRedis } from './redis/client.js';

export const SHUTDOWN_TIMEOUT_MS = 15_000;
export const HEADERS_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const KEEP_ALIVE_TIMEOUT_MS = 15_000;

export interface RunningApi {
  server: Server;
  port: number;
  mail: MailService;
  shutdown: (reason: string) => Promise<void>;
}

export interface StartApiOptions {
  config: AppConfig;
  logger: Logger;
  port?: number;
}

export function applyServerTimeouts(server: Server): void {
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
}

export function listenAsync(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export const IDLE_SWEEP_INTERVAL_MS = 50;

export function closeHttpServer(server: Server, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    const sweep = setInterval(() => {
      server.closeIdleConnections();
    }, IDLE_SWEEP_INTERVAL_MS);
    sweep.unref();

    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, timeoutMs);
    timer.unref();

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(sweep);
      clearTimeout(timer);
      resolve();
    };

    server.close(finish);
    server.closeIdleConnections();
  });
}

export function createHttpServer(app: Express): Server {
  const server = createServer(app);
  applyServerTimeouts(server);
  return server;
}

export async function startApi(options: StartApiOptions): Promise<RunningApi> {
  const { config, logger } = options;

  const handle = await connectDatabase({ uri: config.mongo.uri, logger });
  await ensureDatabaseSchema(handle.db, logger);

  const redis = await connectRedis({ url: config.redis.url, logger });

  const checks: DependencyCheck[] = [
    {
      name: 'mongodb',
      run: async () => {
        await handle.db.command({ ping: 1 });
      },
    },
    {
      name: 'redis',
      run: async () => {
        await redis.ping();
      },
    },
  ];

  const mail = createMailService({ config, logger });
  logger.info({ adapter: mail.adapterName, deliversForReal: mail.deliversForReal }, 'Mailer ready');

  const otp = new OtpService({ redis, db: handle.db, mail, logger, config });
  const sessions = new SessionService({ redis, db: handle.db, config, logger });

  const google =
    config.google === null
      ? undefined
      : new GoogleService({
          redis,
          db: handle.db,
          provider: new GoogleIdentityAdapter({ google: config.google, logger }),
          logger,
        });

  logger.info({ googleSignIn: google !== undefined }, 'Sign in methods ready');

  const authRouter = createAuthRouter({
    otp,
    sessions,
    google,
    isProduction: config.isProduction,
    webOrigin: config.api.webOrigin,
  });

  const routers = [authRouter];

  if (config.github !== null) {
    const tokens = new GitHubAppTokenProvider({ github: config.github, logger });
    const installations = new InstallationService({
      redis,
      db: handle.db,
      tokens,
      directory: new OctokitGitHubDirectory({ github: config.github, logger }),
      github: config.github,
      logger,
    });

    routers.push(createGitHubRouter({ installations, webOrigin: config.api.webOrigin }));
  }

  logger.info({ githubConnect: config.github !== null }, 'GitHub connection ready');

  const app = createApp({
    config,
    logger,
    checks,
    routers,
    attachSession: createAttachSession(sessions, config.isProduction),
  });
  const server = createHttpServer(app);
  const port = await listenAsync(server, options.port ?? config.api.port, config.api.host);

  logger.info({ host: config.api.host, port, environment: config.env }, 'Nimbus API is listening');

  let shuttingDown: Promise<void> | undefined;

  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= (async () => {
      logger.info({ reason }, 'Shutting down');
      await closeHttpServer(server);
      await mail.close();
      await closeRedis();
      await closeDatabase();
      logger.info({ reason }, 'Shutdown complete');
    })();
    return shuttingDown;
  };

  return { server, port, mail, shutdown };
}
