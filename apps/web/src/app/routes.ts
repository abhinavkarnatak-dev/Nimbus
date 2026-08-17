import { SessionIdSchema, type SessionId } from '@nimbus/contracts';

export type Route =
  | { name: 'landing' }
  | { name: 'sign_in' }
  | { name: 'auth_callback' }
  | { name: 'connect' }
  | { name: 'github_callback' }
  | { name: 'dashboard' }
  | { name: 'settings' }
  | { name: 'session'; sessionId: SessionId }
  | { name: 'not_found'; path: string };

export const ROUTE_PATHS = {
  landing: '/',
  sign_in: '/sign-in',
  auth_callback: '/auth/callback',
  connect: '/connect',
  github_callback: '/github/callback',
  dashboard: '/dashboard',
  settings: '/settings',
} as const;

export function sessionPath(sessionId: SessionId): string {
  return `/sessions/${sessionId}`;
}

export function normalisePath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? '/';
  const trimmed = withoutQuery.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function matchRoute(path: string): Route {
  const normalised = normalisePath(path);

  if (normalised === ROUTE_PATHS.landing) {
    return { name: 'landing' };
  }

  if (normalised === ROUTE_PATHS.sign_in) {
    return { name: 'sign_in' };
  }

  if (normalised === ROUTE_PATHS.auth_callback) {
    return { name: 'auth_callback' };
  }

  if (normalised === ROUTE_PATHS.settings) {
    return { name: 'settings' };
  }

  if (normalised === ROUTE_PATHS.connect) {
    return { name: 'connect' };
  }

  if (normalised === ROUTE_PATHS.github_callback) {
    return { name: 'github_callback' };
  }

  if (normalised === ROUTE_PATHS.dashboard) {
    return { name: 'dashboard' };
  }

  const session = /^\/sessions\/([^/]+)$/.exec(normalised);

  if (session !== null) {
    const parsed = SessionIdSchema.safeParse(session[1]);

    if (parsed.success) {
      return { name: 'session', sessionId: parsed.data };
    }
  }

  return { name: 'not_found', path: normalised };
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case 'landing':
      return ROUTE_PATHS.landing;
    case 'sign_in':
      return ROUTE_PATHS.sign_in;
    case 'auth_callback':
      return ROUTE_PATHS.auth_callback;
    case 'connect':
      return ROUTE_PATHS.connect;
    case 'github_callback':
      return ROUTE_PATHS.github_callback;
    case 'dashboard':
      return ROUTE_PATHS.dashboard;
    case 'settings':
      return ROUTE_PATHS.settings;
    case 'session':
      return sessionPath(route.sessionId);
    case 'not_found':
      return route.path;
  }
}

export const PUBLIC_ROUTES: readonly Route['name'][] = [
  'landing',
  'sign_in',
  'auth_callback',
  'not_found',
];

export function needsSignIn(route: Route): boolean {
  return !PUBLIC_ROUTES.includes(route.name);
}
