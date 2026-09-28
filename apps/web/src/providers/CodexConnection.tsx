import { useState } from 'react';

import { Button } from '../ui/Button.js';
import { Loading, Skeleton } from '../ui/Skeleton.js';
import type { CodexAuthHandle } from './useCodexAuth.js';

export function CodexConnection({ auth }: { auth: CodexAuthHandle }): React.JSX.Element {
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState(false);

  if (auth.state === 'loading') return <Loading what="Checking your Codex connection."><Skeleton shape="block" /></Loading>;
  if (auth.state === 'unreachable') {
    return (
      <div className="codex-auth">
        <p className="note note--problem" role="alert">Nimbus could not check your Codex connection.</p>
        <Button tone="secondary" onClick={(): void => void auth.refresh()}>Try again</Button>
      </div>
    );
  }

  const connect = async (): Promise<void> => {
    setWorking(true); setProblem(null);
    try { await auth.connect(); } catch { setProblem('Nimbus could not start Codex sign-in. Try again.'); }
    finally { setWorking(false); }
  };
  const disconnect = async (): Promise<void> => {
    setWorking(true); setProblem(null);
    try { await auth.disconnect(); setAsking(false); } catch { setProblem('Codex could not be disconnected. Try again.'); }
    finally { setWorking(false); }
  };
  const copy = async (): Promise<void> => {
    if (!auth.challenge) return;
    await navigator.clipboard.writeText(auth.challenge.code);
    setCopied(true);
  };

  return (
    <div className="codex-auth">
      {problem && <p className="note note--problem" role="alert">{problem}</p>}
      {auth.connected ? (
        <>
          <p className="codex-auth__status"><span className="codex-auth__dot" />Connected to Codex. Nimbus will use this account for model work.</p>
          {asking ? <div className="panel__acts"><Button tone="danger" disabled={working} onClick={(): void => { void disconnect(); }}>{working ? 'Disconnecting' : 'Yes, disconnect'}</Button><Button tone="quiet" disabled={working} onClick={(): void => { setAsking(false); }}>Keep connected</Button></div> : <Button tone="quiet" onClick={(): void => { setAsking(true); }}>Disconnect Codex</Button>}
        </>
      ) : auth.challenge ? (
        <div className="codex-auth__challenge">
          <p className="panel__body">Open the Codex sign-in page, enter this one-time code, then leave this page open while Nimbus waits for confirmation.</p>
          <div className="codex-auth__code" aria-label="Codex device code">{auth.challenge.code}</div>
          <div className="panel__acts"><a className="button button--primary" href={auth.challenge.url} target="_blank" rel="noreferrer">Open Codex sign-in</a><Button tone="quiet" onClick={(): void => void copy()}>{copied ? 'Copied' : 'Copy code'}</Button></div>
        </div>
      ) : (
        <><p className="panel__body">Use your Codex account instead of a Gemini API key. Nimbus keeps the account connection in the trusted worker and never sends it to a sandbox.</p><Button tone="primary" disabled={working} onClick={(): void => void connect()}>{working ? 'Starting Codex sign-in' : 'Connect Codex account'}</Button></>
      )}
    </div>
  );
}
