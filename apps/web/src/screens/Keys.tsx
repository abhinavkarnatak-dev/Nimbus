import { ROUTE_PATHS } from '../app/routes.js';
import { navigate } from '../app/useRoute.js';
import { ProviderKeys } from '../providers/ProviderKeys.js';
import type { ProviderKeysHandle } from '../providers/useProviderKeys.js';
import { CodexConnection } from '../providers/CodexConnection.js';
import type { CodexAuthHandle } from '../providers/useCodexAuth.js';
import { Button } from '../ui/Button.js';

const TRUTHS: readonly string[] = [
  'Nimbus has no model account of its own. Each session uses the provider account you connect here.',
  'Gemini keys are encrypted before they are written down. Codex credentials stay in the trusted worker and never enter a sandbox.',
  'The models available when starting a session are based on the provider accounts connected here.',
];

export interface KeysProps {
  keys: ProviderKeysHandle;
  codex: CodexAuthHandle;
}

export function Keys({ keys, codex }: KeysProps): React.JSX.Element {
  const ready = keys.keys.length > 0 || codex.connected;

  return (
    <div className="container">
      <section className="connect">
        <div className="connect__card">
          <header className="connect__head">
            <p className="connect__eyebrow">Step 2 of 2</p>
            <h1 className="connect__title">Connect a model account</h1>
            <p className="connect__sub">
              Connect a model account before starting. Use Codex for your Codex account, or add a
              Google Gemini key; Nimbus checks and stores either connection securely.
            </p>
          </header>

          <ProviderKeys keys={keys} />

          <div className="connect__provider-divider" aria-hidden="true">or</div>

          <div className="connect__codex">
            <h2 className="connect__provider-title">Use Codex</h2>
            <CodexConnection auth={codex} />
          </div>

          <ul className="truths">
            {TRUTHS.map((one) => (
              <li className="truths__item" key={one}>
                {one}
              </li>
            ))}
          </ul>

          <div className="connect__actions">
            <Button
              tone="primary"
              large
              disabled={!ready}
              onClick={(): void => {
                navigate(ROUTE_PATHS.dashboard);
              }}
            >
              {ready ? 'Start a session' : 'Connect an account to carry on'}
            </Button>
          </div>

          <p className="connect__foot">
            Whether a session can run is decided by the provider account connected here. You can
            manage these connections later from Settings.
          </p>
        </div>
      </section>
    </div>
  );
}
