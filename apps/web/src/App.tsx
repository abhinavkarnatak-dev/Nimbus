import { AppShell } from './app/AppShell.js';
import { ROUTE_PATHS } from './app/routes.js';
import { navigate, useRoute } from './app/useRoute.js';
import { Landing } from './screens/Landing.js';
import { SignIn } from './screens/SignIn.js';
import { useSession } from './session/useSession.js';

function Waiting(): React.JSX.Element {
  return (
    <div className="container">
      <section className="placeholder">
        <p className="placeholder__eyebrow">Nimbus</p>
        <p className="placeholder__body">Checking who you are.</p>
      </section>
    </div>
  );
}

function Soon({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="container">
      <section className="placeholder">
        <p className="placeholder__eyebrow">{title}</p>
        <h1 className="placeholder__title">Not built yet</h1>
        <p className="placeholder__body">
          This screen arrives with the next feature. Signing in and the landing page work today.
        </p>
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

  const body = ((): React.JSX.Element => {
    if (route.name === 'not_found') {
      return <NotFound path={route.path} />;
    }

    if (route.name === 'landing') {
      return <Landing />;
    }

    if (route.name === 'sign_in') {
      if (session.state === 'checking') {
        return <Waiting />;
      }

      if (signedIn) {
        return <Soon title="Already signed in" />;
      }

      return (
        <SignIn
          api={session.api}
          onSignedIn={(): void => {
            void session.refresh();
            navigate(ROUTE_PATHS.dashboard);
          }}
        />
      );
    }

    if (session.state === 'checking') {
      return <Waiting />;
    }

    if (!signedIn) {
      return <SignIn api={session.api} onSignedIn={(): void => void session.refresh()} />;
    }

    return <Soon title={route.name === 'connect' ? 'Connect GitHub' : 'Dashboard'} />;
  })();

  return <AppShell connection={signedIn ? 'live' : 'idle'}>{body}</AppShell>;
}
