import {
  AUTH_PROVIDER_LABELS,
  GitHubDisconnectResponseSchema,
  LogoutResponseSchema,
  type SessionContext,
} from '@nimbus/contracts';
import { useEffect, useState } from 'react';

import type { ApiClient } from '../api/client.js';
import { ROUTE_PATHS } from '../app/routes.js';
import { navigate } from '../app/useRoute.js';
import {
  disconnectProblem,
  disconnectWords,
  manageUrl,
  repositoriesUpdated,
} from '../github/manage.js';
import type { InstallationHandle } from '../github/useInstallation.js';
import { ProviderKeys } from '../providers/ProviderKeys.js';
import type { ProviderKeysHandle } from '../providers/useProviderKeys.js';
import { Button } from '../ui/Button.js';

export interface SettingsProps {
  api: ApiClient;
  context: SessionContext | null;
  installation: InstallationHandle;
  keys: ProviderKeysHandle;
  onSignedOut: () => Promise<void>;
}

export function Settings({
  api,
  context,
  installation,
  keys,
  onSignedOut,
}: SettingsProps): React.JSX.Element {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [askingOut, setAskingOut] = useState(false);

  const held = installation.installation;
  const refresh = installation.refresh;

  useEffect(() => {
    if (!repositoriesUpdated(globalThis.location.search)) {
      return;
    }

    setSaid('Repositories updated. This is what Nimbus can see now.');
    void refresh();
    globalThis.history.replaceState({}, '', globalThis.location.pathname);
  }, [refresh]);

  const disconnect = async (): Promise<void> => {
    setWorking(true);
    setProblem(null);

    try {
      const done = await api.send({
        method: 'DELETE',
        path: '/github/installation',
        schema: GitHubDisconnectResponseSchema,
      });

      setSaid(disconnectWords(done.uninstalledOnGitHub));
      setAsking(false);
      await installation.refresh();
    } catch (error) {
      setProblem(disconnectProblem(error));
    } finally {
      setWorking(false);
    }
  };

  const signOut = async (): Promise<void> => {
    setLeaving(true);
    setProblem(null);

    try {
      await api.post('/auth/logout', {}, LogoutResponseSchema);
    } catch {
      setProblem('That did not sign you out. Try again.');
      setLeaving(false);
      return;
    }

    await onSignedOut();
    navigate(ROUTE_PATHS.landing);
  };

  return (
    <div className="container">
      <div className="page">
        <header className="page__head">
          <Button
            tone="quiet"
            className="page__back"
            onClick={(): void => {
              navigate(ROUTE_PATHS.dashboard);
            }}
          >
            &larr; Back to dashboard
          </Button>

          <p className="page__eyebrow">Settings</p>
          <h1 className="page__title">Your account</h1>
          <p className="page__sub">
            What Nimbus knows about you, and what it is allowed to reach on GitHub.
          </p>
        </header>

        <section className="panel">
          <h2 className="panel__title">Signed in</h2>

          <dl className="facts">
            <div className="fact">
              <dt>Email</dt>
              <dd>{context?.user.email ?? 'unknown'}</dd>
            </div>

            <div className="fact">
              <dt>Sign in methods</dt>
              <dd>
                {(context?.user.authProviders ?? [])
                  .map((one) => AUTH_PROVIDER_LABELS[one])
                  .join(', ') || 'unknown'}
              </dd>
            </div>
          </dl>

          {askingOut ? (
            <>
              <p className="panel__body">
                Signing out ends this browser session. Anything Nimbus is running carries on, and it
                is here when you come back.
              </p>

              <div className="panel__acts">
                <Button
                  tone="danger"
                  disabled={leaving}
                  onClick={(): void => {
                    void signOut();
                  }}
                >
                  {leaving ? 'Signing out' : 'Yes, sign out'}
                </Button>

                <Button
                  tone="quiet"
                  disabled={leaving}
                  onClick={(): void => {
                    setAskingOut(false);
                  }}
                >
                  Stay signed in
                </Button>
              </div>
            </>
          ) : (
            <div className="panel__acts">
              <Button
                tone="danger"
                onClick={(): void => {
                  setAskingOut(true);
                }}
              >
                Sign out
              </Button>
            </div>
          )}
        </section>

        <section className="panel">
          <h2 className="panel__title">Model API keys</h2>

          <p className="panel__body">
            Nimbus has no model key of its own. Every model call a session makes is billed to the
            key you add here, and which models you can pick when starting a session is decided by
            which keys are here.
          </p>

          <ProviderKeys keys={keys} />
        </section>

        <section className="panel">
          <h2 className="panel__title">GitHub</h2>

          {problem === null ? null : (
            <p className="note note--problem" role="alert">
              <span className="note__mark" aria-hidden="true" />
              {problem}
            </p>
          )}

          {problem === null && said !== null ? (
            <p className="note" role="status">
              <span className="note__mark" aria-hidden="true" />
              {said}
            </p>
          ) : null}

          {held === null ? (
            <>
              <p className="panel__body">
                No GitHub account is connected, so Nimbus cannot read any repository or open any
                pull request.
              </p>

              <a className="button button--primary" href={ROUTE_PATHS.connect}>
                Connect GitHub
              </a>
            </>
          ) : (
            <>
              <dl className="facts">
                <div className="fact">
                  <dt>Account</dt>
                  <dd>
                    {held.accountLogin} <span className="fact__quiet">{held.accountType}</span>
                  </dd>
                </div>

                <div className="fact">
                  <dt>Status</dt>
                  <dd>{installation.gate === 'active' ? 'connected' : installation.gate}</dd>
                </div>

                <div className="fact">
                  <dt>Repositories shared</dt>
                  <dd>{String(installation.repositories.length)}</dd>
                </div>
              </dl>

              {installation.repositories.length === 0 ? null : (
                <ul className="repos">
                  {installation.repositories.map((one) => (
                    <li className="repos__item" key={one.repositoryId}>
                      <span className="repos__name">
                        {one.owner}/{one.name}
                      </span>
                      <span className="repos__branch">{one.defaultBranch}</span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="panel__body">
                Which repositories Nimbus may see is decided on GitHub, not here. Nimbus has no way
                to widen or narrow its own access, which is the point of installing it that way.
              </p>

              <div className="panel__acts">
                <a
                  className="button button--secondary"
                  href={manageUrl(held)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Add or remove repositories on GitHub
                </a>

                <Button
                  tone="quiet"
                  onClick={(): void => {
                    void installation.refresh();
                  }}
                >
                  Check again
                </Button>
              </div>
            </>
          )}
        </section>

        {held === null ? null : (
          <section className="panel panel--warn">
            <h2 className="panel__title">Disconnect</h2>

            <p className="panel__body">
              This uninstalls Nimbus from {held.accountLogin} on GitHub. Pull requests it already
              opened stay where they are, and connecting again means installing it again.
            </p>

            {asking ? (
              <div className="panel__acts">
                <Button
                  tone="danger"
                  disabled={working}
                  onClick={(): void => {
                    void disconnect();
                  }}
                >
                  {working ? 'Disconnecting' : 'Yes, disconnect'}
                </Button>

                <Button
                  tone="quiet"
                  disabled={working}
                  onClick={(): void => {
                    setAsking(false);
                  }}
                >
                  Keep it
                </Button>
              </div>
            ) : (
              <div className="panel__acts">
                <Button
                  tone="danger"
                  onClick={(): void => {
                    setSaid(null);
                    setAsking(true);
                  }}
                >
                  Disconnect GitHub
                </Button>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
