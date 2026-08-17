import { SessionDetailResponseSchema, type SessionDetail, type SessionId } from '@nimbus/contracts';
import { useCallback, useEffect, useState } from 'react';

import type { ApiClient } from '../api/client.js';
import { ApiError, NetworkError } from '../api/errors.js';
import { SOCKET_URL } from '../config.js';
import { SessionSocket, type SocketLike, type SocketState } from '../events/socket.js';
import { applyEvents, liveFrom, type LiveSession } from './live.js';

export const SOCKET_PATH = '/events';

export type LoadState = 'loading' | 'ready' | 'missing' | 'unreachable';

interface Loaded {
  detail: SessionDetail;
  from: number;
}

export interface LiveSessionHandle {
  load: LoadState;
  detail: SessionDetail | null;
  live: LiveSession | null;
  connection: SocketState;
  refresh: () => Promise<void>;
  change: (next: (held: LiveSession) => LiveSession) => void;
}

function openSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export function useLiveSession(api: ApiClient, sessionId: SessionId | null): LiveSessionHandle {
  const [load, setLoad] = useState<LoadState>('loading');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [live, setLive] = useState<LiveSession | null>(null);
  const [connection, setConnection] = useState<SocketState>('idle');

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionId === null) {
      return;
    }

    try {
      const found = await api.get(`/sessions/${sessionId}`, SessionDetailResponseSchema);
      setLoaded({ detail: found.session, from: found.lastEventSequence });
      setLive(liveFrom(found.session));
      setLoad('ready');
    } catch (error) {
      setLoad(error instanceof ApiError && error.code === 'NOT_FOUND' ? 'missing' : 'unreachable');

      if (!(error instanceof NetworkError) && !(error instanceof ApiError)) {
        setLoad('unreachable');
      }
    }
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const from = loaded?.from;

  useEffect(() => {
    if (from === undefined || sessionId === null) {
      return;
    }

    const held = new SessionSocket({
      url: `${SOCKET_URL}${SOCKET_PATH}`,
      sessionId,
      lastEventSequence: from,
      open: openSocket,
      onEvents: (envelopes) => {
        setLive((current) =>
          current === null
            ? current
            : applyEvents(
                current,
                envelopes.map((one) => one.event),
              ),
        );
      },
      onState: setConnection,
    });

    held.start();

    return (): void => {
      held.stop();
    };
  }, [from, sessionId]);

  const change = useCallback((next: (held: LiveSession) => LiveSession): void => {
    setLive((current) => (current === null ? current : next(current)));
  }, []);

  return { load, detail: loaded?.detail ?? null, live, connection, refresh, change };
}
