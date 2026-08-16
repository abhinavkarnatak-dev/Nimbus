import { createServer, type Server } from 'node:http';

import type { Express } from 'express';
import type { Db } from 'mongodb';

import { createApp } from './app.js';
import { StoredAttachmentBytes } from './attachments/bytes.js';
import { MongoAttachmentRecords } from './attachments/repository.js';
import { S3AttachmentStore } from './attachments/s3-store.js';
import { AttachmentService } from './attachments/service.js';
import { AttachmentSweeper } from './attachments/sweeper.js';
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
import { GitHubWebhookService } from './github/webhook-service.js';
import { createAttachSession } from './http/middleware/session.js';
import { createAttachmentsRouter } from './http/routes/attachments.js';
import { createSessionsRouter } from './http/routes/sessions.js';
import { EventHub, listenForEvents } from './events/hub.js';
import { LiveEventPublisher } from './events/publisher.js';
import { MongoEventStore } from './events/store.js';
import { createRoutedTextProvider, createVisionProvider } from './llm/factory.js';
import { SessionAttachments } from './routing/attached.js';
import { ImageDescriber } from './routing/describe.js';
import { providersForPlan } from './routing/requirements.js';
import { planFor, SELECTABLE_TEXT_MODELS } from './routing/selection.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { LiveSessionWorkshop } from './orchestrator/live-workshop.js';
import { SessionRunner } from './orchestrator/runner.js';
import { WaitingSessionSweeper } from './orchestrator/waiting-sweeper.js';
import { OctokitPullRequestClientFactory } from './pull-request/octokit-client.js';
import { TrustedPullRequestGateway } from './pull-request/gateway.js';
import { OctokitGitDataFactory } from './push/octokit-git-data.js';
import { TrustedPushGateway } from './push/gateway.js';
import { MongoApprovals } from './sessions/approvals.js';
import { MongoSessionRecords } from './sessions/repository.js';
import { AgentSessionService } from './sessions/service.js';
import { usersCollection } from './db/models/user.js';
import { createSandboxProvider } from './sandbox/factory.js';
import type { SandboxProvider } from './sandbox/provider.js';
import { createAuthRouter } from './http/routes/auth.js';
import { createGitHubRouter } from './http/routes/github.js';
import type { DependencyCheck } from './http/routes/health.js';
import type { Logger } from './logging/logger.js';
import { LeaseManager } from './redis/lease.js';
import { closeRedis, connectRedis } from './redis/client.js';
import { LiveE2bClient } from './sandbox/e2b-live-client.js';
import { SandboxSweeper, leaseLock } from './sandbox/sweeper.js';

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

export function sandboxProviderFor(config: AppConfig, logger: Logger): SandboxProvider {
  const provider = createSandboxProvider(config.sandbox, {
    isProduction: config.isProduction,
    fake: { files: {} },
  });

  if (!provider.real) {
    logger.warn(
      { provider: config.sandbox.provider, adapter: provider.name, developmentOnly: true },
      'no real sandbox is configured, using a fake',
    );
  }

  return provider;
}

export async function emailOf(db: Db, userId: string): Promise<string> {
  const user = await usersCollection(db).findOne({ userId });

  if (user === null) {
    throw new Error(`no user called ${userId}`);
  }
  return user.email;
}

export async function startApi(options: StartApiOptions): Promise<RunningApi> {
  const { config, logger } = options;

  const plan = planFor();

  logger.info(
    {
      primary: plan.primary,
      light: plan.light,
      reasoning: plan.reasoning,
      vision: plan.vision,
      selectable: SELECTABLE_TEXT_MODELS,
      plannedProviders: providersForPlan(config.llm),
    },
    'Model routing plan ready',
  );

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
  let repositories: InstallationService | null = null;
  let githubTokens: GitHubAppTokenProvider | null = null;

  if (config.github !== null) {
    const tokens = new GitHubAppTokenProvider({ github: config.github, logger });
    githubTokens = tokens;
    const installations = new InstallationService({
      redis,
      db: handle.db,
      tokens,
      directory: new OctokitGitHubDirectory({ github: config.github, logger }),
      github: config.github,
      logger,
    });

    const webhooks = new GitHubWebhookService({
      redis,
      db: handle.db,
      github: config.github,
      logger,
    });

    routers.push(createGitHubRouter({ installations, webhooks, webOrigin: config.api.webOrigin }));
    repositories = installations;
  }

  logger.info({ githubConnect: config.github !== null }, 'GitHub connection ready');

  const attachmentStore = config.storage === null ? null : new S3AttachmentStore(config.storage);
  const attachmentRecords = new MongoAttachmentRecords(handle.db);

  const attachments =
    attachmentStore === null
      ? null
      : new AttachmentService({
          records: attachmentRecords,
          store: attachmentStore,
          maxBytes: config.limits.maxAttachmentBytes,
        });

  const attachedToRuns =
    attachmentStore === null
      ? null
      : new SessionAttachments({
          records: attachmentRecords,
          bytes: new StoredAttachmentBytes(attachmentStore),
          describer: new ImageDescriber({
            vision: createVisionProvider({
              config: config.llm,
              logger,
              isProduction: config.isProduction,
            }),
            records: attachmentRecords,
            bytes: new StoredAttachmentBytes(attachmentStore),
            logger,
          }),
          logger,
        });

  if (attachments !== null) {
    routers.push(
      createAttachmentsRouter({
        attachments,
        sessions,
        maxBytes: config.limits.maxAttachmentBytes,
      }),
    );
  }

  if (repositories !== null) {
    routers.push(
      createSessionsRouter({
        auth: sessions,
        sessions: new AgentSessionService({
          records: new MongoSessionRecords(handle.db),
          attachments: attachmentRecords,
          repositories,
          logger,
          approvalsFor: (sessionId) => new MongoApprovals({ db: handle.db, sessionId }),
        }),
      }),
    );
  }

  logger.info({ agentSessions: repositories !== null }, 'Agent sessions ready');

  const sessionRecords = new MongoSessionRecords(handle.db);
  const eventStore = new MongoEventStore(handle.db);
  const events = new LiveEventPublisher({ store: eventStore, redis, logger });

  const orchestrator =
    repositories === null || githubTokens === null
      ? null
      : new Orchestrator({
          records: new MongoSessionRecords(handle.db),
          leases: new LeaseManager(redis),
          logger,
          runner: new SessionRunner({
            workshop: new LiveSessionWorkshop({
              db: handle.db,
              installations: repositories,
              tokens: githubTokens,
              sandboxes: sandboxProviderFor(config, logger),
              text: createRoutedTextProvider({
                config: config.llm,
                logger,
                isProduction: config.isProduction,
              }),
              config,
              logger,
              events,
              ...(attachedToRuns === null ? {} : { attachments: attachedToRuns }),
            }),
            push: new TrustedPushGateway({
              tokens: githubTokens,
              gitData: new OctokitGitDataFactory(),
              logger,
            }),
            pullRequests: new TrustedPullRequestGateway({
              tokens: githubTokens,
              clients: new OctokitPullRequestClientFactory(),
              mail,
              logger,
            }),
            logger,
            events,
            records: sessionRecords,
            approvalsFor: (sessionId) => new MongoApprovals({ db: handle.db, sessionId }),
            mail,
            notifyEmailFor: async (session) => emailOf(handle.db, session.userId),
          }),
        });

  orchestrator?.start();
  logger.info({ orchestrator: orchestrator !== null }, 'Session orchestrator ready');

  const waitingSweeper = new WaitingSessionSweeper({
    records: sessionRecords,
    logger,
    events,
    mail,
    notifyEmailFor: async (session) => emailOf(handle.db, session.userId),
    withLock: leaseLock(new LeaseManager(redis)),
  });

  waitingSweeper.start();
  logger.info({ waitingSessionSweeper: true }, 'Session wait timeouts ready');

  const attachmentSweeper =
    attachments === null
      ? null
      : new AttachmentSweeper({
          attachments,
          logger,
          withLock: leaseLock(new LeaseManager(redis)),
        });

  attachmentSweeper?.start();
  logger.info({ attachmentUploads: attachments !== null }, 'Attachment storage ready');

  const sweeper =
    config.sandbox.provider === 'e2b' && config.sandbox.apiKey !== undefined
      ? new SandboxSweeper({
          client: new LiveE2bClient(config.sandbox.apiKey),
          logger,
          withLock: leaseLock(new LeaseManager(redis)),
          isSessionLive: async (sessionId: string) => sessionRecords.isLive(sessionId),
        })
      : null;

  sweeper?.start();
  logger.info(
    { sandboxProvider: config.sandbox.provider, orphanSweeper: sweeper !== null },
    'Sandbox provider ready',
  );

  const app = createApp({
    config,
    logger,
    checks,
    routers,
    attachSession: createAttachSession(sessions, config.isProduction),
  });
  const server = createHttpServer(app);

  const hub = new EventHub({
    server,
    redis,
    store: eventStore,
    sessions,
    records: sessionRecords,
    logger,
    allowedOrigin: config.api.webOrigin,
    isProduction: config.isProduction,
  });

  hub.start();
  const eventListener = await listenForEvents(redis, hub, logger);

  const port = await listenAsync(server, options.port ?? config.api.port, config.api.host);

  logger.info({ host: config.api.host, port, environment: config.env }, 'Nimbus API is listening');

  let shuttingDown: Promise<void> | undefined;

  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= (async () => {
      logger.info({ reason }, 'Shutting down');
      await orchestrator?.stop();
      waitingSweeper.stop();
      await hub.stop();
      eventListener.disconnect();
      sweeper?.stop();
      attachmentSweeper?.stop();
      attachmentStore?.destroy();
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
