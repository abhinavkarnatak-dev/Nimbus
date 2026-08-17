import { GitHubConnectResponseSchema } from '@nimbus/contracts';
import { useEffect, useState } from 'react';

import type { ApiClient } from '../api/client.js';
import { ROUTE_PATHS } from '../app/routes.js';
import { navigate } from '../app/useRoute.js';
import { connectProblem, setupWords, type SetupResult } from '../github/installation.js';
import type { InstallationHandle } from '../github/useInstallation.js';
import { Button } from '../ui/Button.js';
import { Loading, Skeleton } from '../ui/Skeleton.js';

const ASKS: readonly string[] = [
  'Read the code of the one public repository you pick, at one commit.',
  'Create a branch that belongs to Nimbus and push the change to it.',
  'Open a pull request on that branch, for you to review.',
];

const NEVERS: readonly string[] = [
  'Merge, approve, close or force push anything.',
  'Write to your default branch, or to any branch it did not create.',
  'Touch a private repository, or one you did not choose.',
];

const HEADINGS: Readonly<Record<string, { title: string; sub: string }>> = {
  never_connected: {
    title: 'Connect GitHub',
    sub: 'This takes two steps. First install the Nimbus app on the account that owns the repository, choosing the one repository it may see. Then come back and connect it, which is where Nimbus confirms the installation is yours.',
  },
  suspended: {
    title: 'That installation is suspended',
    sub: 'GitHub has suspended the Nimbus app on this account, so nothing can be read or pushed. Un-suspend it on GitHub, then check again here.',
  },
  removed: {
    title: 'That installation was removed',
    sub: 'The Nimbus app was uninstalled from this account. Connecting again installs it back, and you pick the repository as before.',
  },
  checking: {
    title: 'Checking GitHub',
    sub: 'Asking the Nimbus server what GitHub has granted for this account.',
  },
  unreachable: {
    title: 'Nimbus cannot check GitHub',
    sub: 'The server did not answer when asked about your installation. Nothing is wrong with your account. Try again in a moment.',
  },
  active: {
    title: 'GitHub is connected',
    sub: 'Nimbus can read the repositories you granted it and open pull requests on them.',
  },
};

function gaveUp(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface ConnectProps {
  api: ApiClient;
  installation: InstallationHandle;
  result?: SetupResult | null;
}

export function Connect({ api, installation, result = null }: ConnectProps): React.JSX.Element {
  const [links, setLinks] = useState<{ redirectUrl: string; installUrl: string | null } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);

  const gate = installation.gate;
  const words = HEADINGS[gate] ?? HEADINGS['never_connected'];
  const notice = result === null ? null : setupWords(result);
  const needsConnecting = gate !== 'active' && gate !== 'checking';

  useEffect(() => {
    if (!needsConnecting) {
      return;
    }

    const stop = new AbortController();

    void (async (): Promise<void> => {
      try {
        const started = await api.get('/github/connect', GitHubConnectResponseSchema, stop.signal);

        setLinks({ redirectUrl: started.redirectUrl, installUrl: started.installUrl });
        setProblem(null);
      } catch (error) {
        if (!gaveUp(stop.signal)) {
          setProblem(connectProblem(error));
        }
      }
    })();

    return (): void => {
      stop.abort();
    };
  }, [api, needsConnecting, gate]);

  return (
    <div className="container">
      <section className="connect">
        <div className="connect__card">
          <header className="connect__head">
            <p className="connect__eyebrow">Step 1 of 2</p>
            <h1 className="connect__title">{words?.title}</h1>
            <p className="connect__sub">{words?.sub}</p>
          </header>

          {problem === null && notice !== null ? (
            <p
              className={`note ${notice.tone === 'good' ? 'note--good' : ''} ${
                notice.tone === 'bad' ? 'note--problem' : ''
              }`}
              role="status"
            >
              <span className="note__mark" aria-hidden="true" />
              {notice.text}
            </p>
          ) : null}

          {problem === null ? null : (
            <p className="note note--problem" role="alert">
              <span className="note__mark" aria-hidden="true" />
              {problem}
            </p>
          )}

          {installation.installation === null ? null : (
            <p className="connect__account">
              <span className="connect__login">{installation.installation.accountLogin}</span>
              <span>{installation.installation.accountType}</span>
              <span className="connect__state" data-gate={gate}>
                {gate === 'active' ? 'connected' : gate}
              </span>
            </p>
          )}

          {gate === 'checking' ? (
            <Loading what="Checking what GitHub has granted.">
              <div className="skeleton-stack">
                <Skeleton shape="line" width="60%" />
                <Skeleton shape="block" />
              </div>
            </Loading>
          ) : gate === 'active' ? (
            <p className="connect__sub">
              {installation.repositories.length === 0
                ? 'No repository is shared with Nimbus yet. Change what the app can see on GitHub, then check again.'
                : `${String(installation.repositories.length)} ${
                    installation.repositories.length === 1 ? 'repository is' : 'repositories are'
                  } shared with Nimbus.`}
            </p>
          ) : (
            <div className="grants">
              <div className="grants__group">
                <p className="grants__word">What it asks for</p>
                <ul className="grants__list">
                  {ASKS.map((one) => (
                    <li className="grants__item" key={one}>
                      <span className="grants__sign" aria-hidden="true">
                        +
                      </span>
                      {one}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="grants__group">
                <p className="grants__word">What it can never do</p>
                <ul className="grants__list">
                  {NEVERS.map((one) => (
                    <li className="grants__item grants__item--never" key={one}>
                      <span className="grants__sign" aria-hidden="true">
                        &minus;
                      </span>
                      {one}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {needsConnecting ? (
            <div className="connect__go">
              {links === null ? (
                <Skeleton shape="button" width="14rem" />
              ) : (
                <a
                  className="button button--primary button--large"
                  href={links.installUrl ?? links.redirectUrl}
                  rel="noreferrer"
                >
                  {gate === 'never_connected' ? 'Install on GitHub' : 'Connect again'}
                </a>
              )}

              <p className="connect__hint">
                GitHub asks which repository the app may see, then sends you straight back here.
                {links?.installUrl == null ? null : (
                  <>
                    {' '}
                    Already installed it?{' '}
                    <a href={links.redirectUrl} rel="noreferrer">
                      Connect it directly
                    </a>
                    .
                  </>
                )}
              </p>
            </div>
          ) : null}

          <div className="connect__actions">
            {gate === 'active' ? (
              <Button
                tone="primary"
                large
                onClick={(): void => {
                  navigate(ROUTE_PATHS.dashboard);
                }}
              >
                Start a session
              </Button>
            ) : null}

            <Button
              tone="secondary"
              large
              onClick={(): void => {
                void installation.refresh();
              }}
            >
              Check again
            </Button>
          </div>

          <p className="connect__foot">
            Whether Nimbus can run is decided by GitHub and by the Nimbus server, not by this page.
            Nothing here unlocks anything the server has not already granted.
          </p>
        </div>
      </section>
    </div>
  );
}
