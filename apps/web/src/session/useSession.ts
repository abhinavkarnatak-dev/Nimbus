import { MeResponseSchema, type SessionContext } from '@nimbus/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiClient, type CsrfSource } from '../api/client.js';
import { ApiError, NetworkError } from '../api/errors.js';
import { API_BASE_URL } from '../config.js';

export type SignedInState = 'checking' | 'signed_in' | 'signed_out' | 'unreachable';

export interface SessionHandle {
  state: SignedInState;
  context: SessionContext | null;
  api: ApiClient;
  csrf: CsrfSource;
  refresh: () => Promise<void>;
}

export function useSession(): SessionHandle {
  const [state, setState] = useState<SignedInState>('checking');
  const [context, setContext] = useState<SessionContext | null>(null);
  const held = useRef<SessionContext | null>(null);

  const csrf: CsrfSource = useRef<CsrfSource>({
    token: (): string | null => held.current?.csrfToken ?? null,
  }).current;

  const api = useRef(new ApiClient({ baseUrl: API_BASE_URL, csrf })).current;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const me = await api.get('/auth/me', MeResponseSchema);
      held.current = me;
      setContext(me);
      setState('signed_in');
    } catch (error) {
      held.current = null;
      setContext(null);

      if (error instanceof NetworkError) {
        setState('unreachable');
        return;
      }

      if (error instanceof ApiError && !error.signedOut) {
        setState('unreachable');
        return;
      }

      setState('signed_out');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, context, api, csrf, refresh };
}
