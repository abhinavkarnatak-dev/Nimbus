import {
  GitHubConnectResponseSchema,
  RepositoriesResponseSchema,
  type InstallationSummary,
} from '@nimbus/contracts';
import { Router } from 'express';

import type { RepositoriesResult } from '../../github/installation-service.js';
import { ApiError } from '../api-error.js';
import { createRequireAuth, requireSession } from '../middleware/session.js';
import { clientIp } from './auth.js';

export interface GitHubSetupService {
  beginConnect(userId: string): Promise<{ redirectUrl: string; state: string }>;
  completeSetup(input: {
    userId: string;
    installationId: number;
    state: string;
    code: string;
    ip: string;
  }): Promise<InstallationSummary>;
  listRepositories(userId: string): Promise<RepositoriesResult>;
}

export interface GitHubRouterOptions {
  installations: GitHubSetupService;
  webOrigin: string;
}

export const SETUP_LANDING_PATH = '/github/callback';

export function setupRedirect(webOrigin: string, outcome: string, reason?: string): string {
  const url = new URL(SETUP_LANDING_PATH, webOrigin);

  url.searchParams.set('github', outcome);
  if (reason !== undefined) {
    url.searchParams.set('reason', reason);
  }
  return url.toString();
}

export function parseInstallationId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[0-9]{1,15}$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createGitHubRouter(options: GitHubRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth();

  router.get('/github/connect', requireAuth, async (request, response) => {
    const session = requireSession(request);
    const started = await options.installations.beginConnect(session.user.userId);

    response
      .status(200)
      .json(GitHubConnectResponseSchema.parse({ redirectUrl: started.redirectUrl }));
  });

  router.get('/github/setup/callback', requireAuth, async (request, response) => {
    const session = requireSession(request);
    const query = request.query as Record<string, unknown>;

    const action = typeof query['setup_action'] === 'string' ? query['setup_action'] : '';
    if (action === 'cancel') {
      response.redirect(302, setupRedirect(options.webOrigin, 'cancelled'));
      return;
    }

    const installationId = parseInstallationId(query['installation_id']);
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    const code = typeof query['code'] === 'string' ? query['code'] : '';

    if (state === '') {
      response.redirect(302, setupRedirect(options.webOrigin, 'failed', 'OAUTH_STATE_INVALID'));
      return;
    }

    try {
      await options.installations.completeSetup({
        userId: session.user.userId,
        installationId: installationId ?? 0,
        state,
        code,
        ip: clientIp(request.ip),
      });
    } catch (error) {
      if (error instanceof ApiError) {
        response.redirect(302, setupRedirect(options.webOrigin, 'failed', error.code));
        return;
      }
      throw error;
    }

    response.redirect(302, setupRedirect(options.webOrigin, 'connected'));
  });

  router.get('/github/repositories', requireAuth, async (request, response) => {
    const session = requireSession(request);
    const result = await options.installations.listRepositories(session.user.userId);

    response.status(200).json(RepositoriesResponseSchema.parse(result));
  });

  return router;
}
