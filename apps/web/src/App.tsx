import { AppShell } from './app/AppShell.js';
import { useRoute } from './app/useRoute.js';
import { useSession } from './session/useSession.js';
import type { Route } from './app/routes.js';
import type { SignedInState } from './session/useSession.js';

const ROUTE_TITLES: Readonly<Record<Route['name'], string>> = {
  landing: 'Landing',
  sign_in: 'Sign in',
  connect: 'Connect GitHub',
  dashboard: 'Dashboard',
  session: 'Session',
  not_found: 'Not found',
};

const STATE_WORDS: Readonly<Record<SignedInState, string>> = {
  checking: 'Asking the server who you are',
  signed_in: 'Signed in',
  signed_out: 'Not signed in',
  unreachable: 'The Nimbus API is not answering',
};

export function App(): React.JSX.Element {
  const route = useRoute();
  const session = useSession();

  return (
    <AppShell connection={session.state === 'signed_in' ? 'live' : 'idle'}>
      <div className="container">
        <section className="placeholder">
          <p className="placeholder__eyebrow">{ROUTE_TITLES[route.name]}</p>
          <h1 className="placeholder__title">The shell is standing</h1>
          <p className="placeholder__body">
            Routing, the typed API client, the reconnecting socket and the safe rendering primitives
            are in place. Screens arrive from 040 onward.
          </p>
          <p className="placeholder__body">
            {STATE_WORDS[session.state]}
            {session.context === null ? '' : `, as ${session.context.user.email}`}.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
