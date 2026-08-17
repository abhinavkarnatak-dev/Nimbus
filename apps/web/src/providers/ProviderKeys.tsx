import { providerKeyProblem, type LlmProviderName } from '@nimbus/contracts';
import { useState } from 'react';

import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Loading, Skeleton } from '../ui/Skeleton.js';
import {
  PROVIDER_ORDER,
  addedOn,
  removeProblem,
  removedWords,
  savedKeyFor,
  savedWords,
  saveProblem,
  shapeOf,
} from './keys.js';
import type { ProviderKeysHandle } from './useProviderKeys.js';

export interface ProviderKeysProps {
  keys: ProviderKeysHandle;
}

interface RowProps {
  provider: LlmProviderName;
  keys: ProviderKeysHandle;
  onSaid: (said: string) => void;
}

function ProviderRow({ provider, keys, onSaid }: RowProps): React.JSX.Element {
  const shape = shapeOf(provider);
  const saved = savedKeyFor(keys.keys);

  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState(false);

  const shapeProblem = typed === '' ? null : providerKeyProblem(provider, typed);

  const save = async (): Promise<void> => {
    const refusal = providerKeyProblem(provider, typed);

    if (refusal !== null) {
      setProblem(refusal);
      return;
    }

    setWorking(true);
    setProblem(null);

    try {
      await keys.save(provider, typed.trim());
      setTyped('');
      setOpen(false);
      onSaid(savedWords(provider));
    } catch (error) {
      setProblem(saveProblem(error));
    } finally {
      setWorking(false);
    }
  };

  const remove = async (): Promise<void> => {
    setWorking(true);
    setProblem(null);

    try {
      await keys.remove(provider);
      setAsking(false);
      onSaid(removedWords(provider));
    } catch (error) {
      setProblem(removeProblem(error));
    } finally {
      setWorking(false);
    }
  };

  return (
    <li className="keys__row" data-saved={saved === null ? 'no' : 'yes'}>
      <div className="keys__head">
        <div className="keys__who">
          <span className="keys__name">{shape.label}</span>
          <span className="keys__models">{shape.models}</span>
        </div>

        {saved === null ? (
          <span className="keys__state keys__state--none">not added</span>
        ) : (
          <span className="keys__state keys__state--held">
            <span className="keys__hint">ends {saved.hint}</span>
            <span className="keys__when">added {addedOn(saved)}</span>
          </span>
        )}
      </div>

      {problem === null ? null : (
        <p className="note note--problem" role="alert">
          <span className="note__mark" aria-hidden="true" />
          {problem}
        </p>
      )}

      {saved !== null && !open ? (
        <div className="keys__acts">
          {asking ? (
            <>
              <span className="keys__ask">
                Removing this key stops every model it pays for. Sessions already running carry on.
              </span>

              <Button
                tone="secondary"
                disabled={working}
                onClick={(): void => {
                  void remove();
                }}
              >
                {working ? 'Removing' : 'Yes, remove'}
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
            </>
          ) : (
            <>
              <Button
                tone="quiet"
                onClick={(): void => {
                  setOpen(true);
                  setProblem(null);
                }}
              >
                Replace key
              </Button>

              <Button
                tone="quiet"
                onClick={(): void => {
                  setAsking(true);
                  setProblem(null);
                }}
              >
                Remove
              </Button>
            </>
          )}
        </div>
      ) : (
        <form
          className="keys__form"
          onSubmit={(event): void => {
            event.preventDefault();
            void save();
          }}
        >
          <Field
            label={`${shape.label} API key`}
            type="password"
            code
            autoComplete="off"
            spellCheck={false}
            placeholder={shape.example}
            value={typed}
            disabled={working}
            problem={shapeProblem}
            hint={`Paste the key from ${shape.where}. Nimbus checks it before saving, and never shows it again.`}
            onChange={(event): void => {
              setTyped(event.target.value);
              setProblem(null);
            }}
          />

          <div className="keys__acts">
            <Button tone="primary" type="submit" disabled={working || typed.trim() === ''}>
              {working ? 'Checking with the provider' : saved === null ? 'Add key' : 'Replace key'}
            </Button>

            <a
              className="button button--quiet"
              href={shape.consoleUrl}
              target="_blank"
              rel="noreferrer"
            >
              Get a key
            </a>

            {saved === null ? null : (
              <Button
                tone="quiet"
                disabled={working}
                onClick={(): void => {
                  setOpen(false);
                  setTyped('');
                  setProblem(null);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </li>
  );
}

export function ProviderKeys({ keys }: ProviderKeysProps): React.JSX.Element {
  const [said, setSaid] = useState<string | null>(null);

  if (keys.state === 'loading') {
    return (
      <Loading what="Checking which keys this account has saved.">
        <div className="skeleton-stack">
          <Skeleton shape="line" width="45%" />
          <Skeleton shape="block" />
          <Skeleton shape="block" />
        </div>
      </Loading>
    );
  }

  if (keys.state === 'unreachable') {
    return (
      <>
        <p className="note note--problem" role="alert">
          <span className="note__mark" aria-hidden="true" />
          Nimbus could not say which keys this account has. Nothing was changed.
        </p>

        <div className="keys__acts">
          <Button
            tone="secondary"
            onClick={(): void => {
              void keys.refresh();
            }}
          >
            Try again
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      {said === null ? null : (
        <p className="note note--good" role="status">
          <span className="note__mark" aria-hidden="true" />
          {said}
        </p>
      )}

      <ul className="keys">
        {PROVIDER_ORDER.map((provider) => (
          <ProviderRow key={provider} provider={provider} keys={keys} onSaid={setSaid} />
        ))}
      </ul>
    </>
  );
}
