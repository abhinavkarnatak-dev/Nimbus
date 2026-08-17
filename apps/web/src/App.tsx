import { useEffect } from 'react';

import { AppShell } from './app/AppShell.js';
import { ROUTE_PATHS } from './app/routes.js';
import { navigate, useRoute } from './app/useRoute.js';
import { readSignInResult, signInResultProblem } from './auth/signin.js';
import { gateIsOpen, readSetupResult } from './github/installation.js';
import { useInstallation } from './github/useInstallation.js';
import { Connect } from './screens/Connect.js';
import { Dashboard } from './screens/Dashboard.js';
import { Keys } from './screens/Keys.js';
import { Landing } from './screens/Landing.js';
import { Session } from './screens/Session.js';
import { Settings } from './screens/Settings.js';
import { SignIn } from './screens/SignIn.js';
import { useProviderKeys } from './providers/useProviderKeys.js';
import { useSession } from './session/useSession.js';
import { useLiveSession } from './sessions/useLiveSession.js';
import { useSessions } from './sessions/useSessions.js';
import { ConnectSkeleton, DashboardSkeleton, HeroSkeleton, SignInSkeleton } from './ui/Skeleton.js';

const AWAY_ONCE_SIGNED_IN: readonly string[] = ['landing', 'sign_in', 'auth_callback'];

function NotFound({ path }: { path: string }): React.JSX.Element {
  return (
    <div className="container">
      <section className="placeholder">
        <p className="placeholder__eyebrow">404</p>
        <h1 className="placeholder__title">Nothing lives here</h1>
        <p className="placeholder__body">
          There is no page at <code>{path}</code>.
        </p>
      </section>
    </div>
  );
}

export function App(): React.JSX.Element {
  const route = useRoute();
  const session = useSession();

  const signedIn = session.state === 'signed_in';
  const installation = useInstallation(session.api, signedIn);
  const keys = useProviderKeys(session.api, signedIn);
  const sessions = useSessions(
    session.api,
    signedIn && gateIsOpen(installation.gate) && keys.keys.length > 0,
  );
  const watching = route.name === 'session' ? route.sessionId : null;
  const liveView = useLiveSession(session.api, watching);

  const onGitHubCallback = route.name === 'github_callback';
  const onAuthCallback = route.name === 'auth_callback';
  const refreshInstallation = installation.refresh;
  const refreshSession = session.refresh;

  useEffect(() => {
    if (onAuthCallback) {
      void refreshSession();
    }
  }, [onAuthCallback, refreshSession]);

  useEffect(() => {
    if (onGitHubCallback && signedIn) {
      void refreshInstallation();
    }
  }, [onGitHubCallback, signedIn, refreshInstallation]);

  useEffect(() => {
    if (signedIn && AWAY_ONCE_SIGNED_IN.includes(route.name)) {
      navigate(ROUTE_PATHS.dashboard);
    }
  }, [signedIn, route.name]);

  const body = ((): React.JSX.Element => {
    if (route.name === 'not_found') {
      return <NotFound path={route.path} />;
    }

    if (route.name === 'landing') {
      return session.state === 'checking' ? <HeroSkeleton /> : <Landing />;
    }

    if (session.state === 'checking') {
      return <SignInSkeleton />;
    }

    if (!signedIn) {
      const carried = onAuthCallback ? readSignInResult(globalThis.location.search) : null;

      return (
        <SignIn
          api={session.api}
          initialProblem={carried === null ? null : signInResultProblem(carried)}
          onSignedIn={(): void => {
            void session.refresh();
            navigate(ROUTE_PATHS.dashboard);
          }}
        />
      );
    }

    if (AWAY_ONCE_SIGNED_IN.includes(route.name)) {
      return <ConnectSkeleton what="Taking you to your dashboard." />;
    }

    if (route.name === 'connect' || onGitHubCallback) {
      return (
        <Connect
          api={session.api}
          installation={installation}
          result={onGitHubCallback ? readSetupResult(globalThis.location.search) : null}
        />
      );
    }

    if (installation.gate === 'checking') {
      return <ConnectSkeleton />;
    }

    if (!gateIsOpen(installation.gate)) {
      return <Connect api={session.api} installation={installation} />;
    }

    if (route.name === 'settings') {
      return (
        <Settings
          api={session.api}
          context={session.context}
          installation={installation}
          keys={keys}
          onSignedOut={(): void => void session.refresh()}
        />
      );
    }

    if (keys.state === 'loading') {
      return <ConnectSkeleton what="Checking which model keys this account has." />;
    }

    if (route.name === 'keys' || keys.keys.length === 0) {
      return <Keys keys={keys} />;
    }

    if (route.name === 'session') {
      return (
        <Session
          api={session.api}
          sessionId={route.sessionId}
          view={liveView}
          sessions={sessions}
        />
      );
    }

    if (sessions.state === 'loading') {
      return <DashboardSkeleton />;
    }

    return (
      <Dashboard
        api={session.api}
        csrf={session.csrf}
        sessions={sessions}
        installation={installation}
      />
    );
  })();

  const bareRoutes: readonly string[] = ['dashboard', 'settings', 'session'];
  const chrome = !bareRoutes.includes(route.name) && session.state !== 'checking';

  const auth = session.state === 'checking' ? 'checking' : signedIn ? 'signed_in' : 'signed_out';

  return (
    <AppShell auth={auth} chrome={chrome}>
      {body}
    </AppShell>
  );
}
