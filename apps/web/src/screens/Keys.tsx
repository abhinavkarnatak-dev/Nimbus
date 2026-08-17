import { ROUTE_PATHS } from '../app/routes.js';
import { navigate } from '../app/useRoute.js';
import { ProviderKeys } from '../providers/ProviderKeys.js';
import type { ProviderKeysHandle } from '../providers/useProviderKeys.js';
import { Button } from '../ui/Button.js';

const TRUTHS: readonly string[] = [
  'Nimbus has no model key of its own. Every model call a session makes is billed to the key you add here.',
  'The key is encrypted before it is written down, and this page only ever shows its last four characters.',
  'Add your Google Gemini key. Which models you can pick when starting a session is decided by that key.',
];

export interface KeysProps {
  keys: ProviderKeysHandle;
}

export function Keys({ keys }: KeysProps): React.JSX.Element {
  const ready = keys.keys.length > 0;

  return (
    <div className="container">
      <section className="connect">
        <div className="connect__card">
          <header className="connect__head">
            <p className="connect__eyebrow">Step 2 of 2</p>
            <h1 className="connect__title">Add a model key</h1>
            <p className="connect__sub">
              Nimbus runs on your own Google Gemini account, not on ours. Paste your Gemini key and
              Nimbus will check it with Google before saving anything.
            </p>
          </header>

          <ProviderKeys keys={keys} />

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
              {ready ? 'Start a session' : 'Add a key to carry on'}
            </Button>
          </div>

          <p className="connect__foot">
            Whether a session can run is decided by the provider that issued your key, not by this
            page. Remove a key here and the models it pays for disappear from the list.
          </p>
        </div>
      </section>
    </div>
  );
}
