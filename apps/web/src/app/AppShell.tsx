import type { ReactNode } from 'react';

import type { SocketState } from '../events/socket.js';
import { Skeleton } from '../ui/Skeleton.js';
import { ROUTE_PATHS } from './routes.js';

export const CONNECTION_WORDS: Readonly<Record<SocketState, string>> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  live: 'Live',
  waiting: 'Reconnecting',
  signed_out: 'Signed out',
  closed: 'Disconnected',
};

export type ShellAuth = 'checking' | 'signed_in' | 'signed_out';

export interface AppShellProps {
  children: ReactNode;
  connection?: SocketState;
  auth?: ShellAuth;
}

export function AppShell({
  children,
  connection = 'idle',
  auth = 'checking',
}: AppShellProps): React.JSX.Element {
  return (
    <div className="shell">
      <header className="shell__bar">
        <a className="shell__brand" href={ROUTE_PATHS.landing}>
          <span className="shell__mark" aria-hidden="true">
            N
          </span>
          Nimbus
        </a>

        <div className="shell__end">
          {auth === 'signed_in' ? (
            <p className="shell__status" data-state={connection} aria-live="polite">
              <span className="shell__status-dot" aria-hidden="true" />
              <span className="shell__status-text" aria-hidden="true">
                {CONNECTION_WORDS[connection]}
              </span>
              <span className="visually-hidden">Connection: {CONNECTION_WORDS[connection]}</span>
            </p>
          ) : null}

          {auth === 'checking' ? <Skeleton shape="pill" width="6rem" /> : null}

          {auth === 'signed_out' ? (
            <a className="button button--secondary shell__action" href={ROUTE_PATHS.sign_in}>
              Sign in
            </a>
          ) : null}

          {auth === 'signed_in' ? (
            <nav className="shell__links" aria-label="Nimbus">
              <a className="button button--quiet shell__action" href={ROUTE_PATHS.connect}>
                GitHub
              </a>
              <a className="button button--secondary shell__action" href={ROUTE_PATHS.dashboard}>
                Dashboard
              </a>
            </nav>
          ) : null}
        </div>
      </header>

      <main className="shell__main">{children}</main>

      <footer className="shell__foot">
        <span>Nimbus reviews nothing on your behalf. Every change arrives as a pull request.</span>
      </footer>
    </div>
  );
}
