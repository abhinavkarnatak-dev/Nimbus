import {
  ProviderKeysResponseSchema,
  type LlmProviderName,
  type ProviderKeySummary,
} from '@nimbus/contracts';
import { useCallback, useEffect, useState } from 'react';

import type { ApiClient } from '../api/client.js';

export type KeysState = 'loading' | 'ready' | 'unreachable';

export interface ProviderKeysHandle {
  state: KeysState;
  keys: readonly ProviderKeySummary[];
  providers: readonly LlmProviderName[];
  save: (provider: LlmProviderName, apiKey: string) => Promise<void>;
  remove: (provider: LlmProviderName) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useProviderKeys(api: ApiClient, enabled: boolean): ProviderKeysHandle {
  const [state, setState] = useState<KeysState>('loading');
  const [keys, setKeys] = useState<readonly ProviderKeySummary[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    setState('loading');

    try {
      const held = await api.get('/provider-keys', ProviderKeysResponseSchema);
      setKeys(held.keys);
      setState('ready');
    } catch {
      setKeys([]);
      setState('unreachable');
    }
  }, [api]);

  const save = useCallback(
    async (provider: LlmProviderName, apiKey: string): Promise<void> => {
      const held = await api.post(
        '/provider-keys',
        { provider, apiKey },
        ProviderKeysResponseSchema,
      );

      setKeys(held.keys);
      setState('ready');
    },
    [api],
  );

  const remove = useCallback(
    async (provider: LlmProviderName): Promise<void> => {
      const held = await api.send({
        method: 'DELETE',
        path: `/provider-keys/${provider}`,
        schema: ProviderKeysResponseSchema,
      });

      setKeys(held.keys);
      setState('ready');
    },
    [api],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return {
    state,
    keys,
    providers: keys.map((one) => one.provider),
    save,
    remove,
    refresh,
  };
}
