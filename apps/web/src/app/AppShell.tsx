import type { ReactNode } from 'react';

import type { SocketState } from '../events/socket.js';
import { ROUTE_PATHS } from './routes.js';

export const CONNECTION_WORDS: Readonly<Record<SocketState, string>> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  live: 'Live',
  waiting: 'Reconnecting',
  signed_out: 'Signed out',
  closed: 'Disconnected',
};

export interface AppShellProps {
  children: ReactNode;
  connection?: SocketState;
}

export function AppShell({ children, connection = 'idle' }: AppShellProps): React.JSX.Element {
  return (
    <div className="shell">
      <header className="shell__bar">
        <a className="shell__brand" href={ROUTE_PATHS.landing}>
          <span className="shell__mark" aria-hidden="true">
            N
          </span>
          Nimbus
        </a>

        <p className="shell__status" data-state={connection} aria-live="polite">
          <span className="shell__status-dot" aria-hidden="true" />
          <span className="shell__status-text" aria-hidden="true">
            {CONNECTION_WORDS[connection]}
          </span>
          <span className="visually-hidden">Connection: {CONNECTION_WORDS[connection]}</span>
        </p>
      </header>

      <main className="shell__main">{children}</main>

      <footer className="shell__foot">
        <span>Nimbus reviews nothing on your behalf. Every change arrives as a pull request.</span>
      </footer>
    </div>
  );
}
