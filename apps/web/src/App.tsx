import { useEffect } from 'react';

import { AppShell } from './app/AppShell.js';
import { ROUTE_PATHS } from './app/routes.js';
import { navigate, useRoute } from './app/useRoute.js';
import { readSignInResult, signInResultProblem } from './auth/signin.js';
import { gateIsOpen, readSetupResult } from './github/installation.js';
import { useInstallation } from './github/useInstallation.js';
import { Connect } from './screens/Connect.js';
import { Landing } from './screens/Landing.js';
import { SignIn } from './screens/SignIn.js';
import { useSession } from './session/useSession.js';
import { ConnectSkeleton, HeroSkeleton, SignInSkeleton } from './ui/Skeleton.js';

const AWAY_ONCE_SIGNED_IN: readonly string[] = ['landing', 'sign_in', 'auth_callback'];

function Soon({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="container">
      <section className="placeholder">
        <p className="placeholder__eyebrow">{title}</p>
        <h1 className="placeholder__title">Not built yet</h1>
        <p className="placeholder__body">This screen arrives with the next feature.</p>
      </section>
    </div>
  );
}

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

    return <Soon title={route.name === 'session' ? 'Session' : 'Dashboard'} />;
  })();

  const auth = session.state === 'checking' ? 'checking' : signedIn ? 'signed_in' : 'signed_out';

  return (
    <AppShell connection={signedIn ? 'live' : 'idle'} auth={auth}>
      {body}
    </AppShell>
  );
}
