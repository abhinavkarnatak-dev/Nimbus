import {
  ModelCatalogueResponseSchema,
  SessionListResponseSchema,
  type SelectableModel,
  type SessionId,
  type SessionSummary,
} from '@nimbus/contracts';
import { useCallback, useEffect, useState } from 'react';

import type { ApiClient } from '../api/client.js';

export type ListState = 'loading' | 'ready' | 'unreachable';

export interface SessionsHandle {
  state: ListState;
  sessions: readonly SessionSummary[];
  activeSessionId: SessionId | null;
  models: readonly SelectableModel[];
  refresh: () => Promise<void>;
  replaceSession: (session: SessionSummary) => void;
}

export function useSessions(api: ApiClient, enabled: boolean): SessionsHandle {
  const [state, setState] = useState<ListState>('loading');
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<SessionId | null>(null);
  const [models, setModels] = useState<readonly SelectableModel[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const listed = await api.get('/sessions', SessionListResponseSchema);
      setSessions(listed.sessions);
      setActiveSessionId(listed.activeSessionId);
      setState('ready');
    } catch {
      setState('unreachable');
      return;
    }

    try {
      const catalogue = await api.get('/models', ModelCatalogueResponseSchema);
      setModels(catalogue.models);
    } catch {
      setModels([]);
    }
  }, [api]);

  const replaceSession = useCallback((session: SessionSummary): void => {
    setSessions((current) =>
      current.map((held) => (held.sessionId === session.sessionId ? session : held)),
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { state, sessions, activeSessionId, models, refresh, replaceSession };
}
