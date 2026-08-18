import type { ReactNode } from 'react';

import { ROUTE_PATHS } from './routes.js';

export type ShellAuth = 'checking' | 'signed_in' | 'signed_out';

export interface AppShellProps {
  children: ReactNode;
  auth?: ShellAuth;
  chrome?: boolean;
}

export function AppShell({
  children,
  auth = 'checking',
  chrome = true,
}: AppShellProps): React.JSX.Element {
  return (
    <div className="shell" data-chrome={chrome}>
      {chrome ? (
        <header className="shell__bar">
          <a className="shell__brand" href={ROUTE_PATHS.landing}>
            <span className="shell__mark" aria-hidden="true">
              N
            </span>
            Nimbus
          </a>

          <div className="shell__end">
            {auth === 'signed_out' ? (
              <a className="button button--secondary shell__action" href={ROUTE_PATHS.sign_in}>
                Sign in
              </a>
            ) : null}
          </div>
        </header>
      ) : null}

      <main className="shell__main">{children}</main>

      {chrome ? (
        <footer className="shell__foot">
          <span>
            Nimbus reviews nothing on your behalf. Every change arrives as a pull request.
          </span>
        </footer>
      ) : null}
    </div>
  );
}
