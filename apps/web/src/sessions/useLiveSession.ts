import { SessionDetailResponseSchema, type SessionDetail, type SessionId } from '@nimbus/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../api/client.js';
import { ApiError, NetworkError } from '../api/errors.js';
import { SOCKET_URL } from '../config.js';
import { SessionSocket, type SocketLike, type SocketState } from '../events/socket.js';
import { applySessionEvents, liveFrom, type LiveSession } from './live.js';

export const SOCKET_PATH = '/events';

export const FROM_THE_START = 0;
export const MAX_CACHED_SESSIONS = 8;

const TERMINAL_STATUSES = new Set(['completed', 'pr_created', 'failed', 'cancelled', 'ready']);

export type LoadState = 'loading' | 'ready' | 'missing' | 'unreachable';

interface Loaded {
  sessionId: SessionId;
  detail: SessionDetail;
  from: number;
  snapshotSequence: number;
}

interface CachedSession {
  live: LiveSession;
  lastEventSequence: number;
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

function rememberSession(
  cache: Map<SessionId, CachedSession>,
  sessionId: SessionId,
  value: CachedSession,
): void {
  cache.delete(sessionId);
  cache.set(sessionId, value);

  while (cache.size > MAX_CACHED_SESSIONS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function mergeSnapshot(
  next: LiveSession,
  current: CachedSession | null,
  snapshotSequence: number,
): LiveSession {
  if (current === null) return next;

  // The HTTP snapshot may have been read before an event that the socket has
  // already applied. In that case the cached state is newer in its entirety;
  // replacing any of it would advance the cursor while losing that event.
  if (current.lastEventSequence > snapshotSequence) return current.live;

  return {
    ...next,
    // Tool output is intentionally delivered by the event stream and is not part
    // of the session-detail response. A status refresh must never erase it.
    tools: current.live.tools,
    files: next.files.length === 0 ? current.live.files : next.files,
    checks: next.checks.length === 0 ? current.live.checks : next.checks,
  };
}

export function useLiveSession(api: ApiClient, sessionId: SessionId | null): LiveSessionHandle {
  const [load, setLoad] = useState<LoadState>('loading');
  const [loadSessionId, setLoadSessionId] = useState<SessionId | null>(sessionId);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [live, setLive] = useState<LiveSession | null>(null);
  const [connection, setConnection] = useState<SocketState>('idle');
  const activeSessionId = useRef<SessionId | null>(sessionId);
  const refreshGeneration = useRef(0);
  const cache = useRef(new Map<SessionId, CachedSession>());

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionId === null) {
      return;
    }

    const requestedSessionId = sessionId;
    const generation = ++refreshGeneration.current;

    try {
      const found = await api.get(`/sessions/${requestedSessionId}`, SessionDetailResponseSchema);

      if (
        activeSessionId.current !== requestedSessionId ||
        generation !== refreshGeneration.current
      ) {
        return;
      }

      const cached = cache.current.get(requestedSessionId) ?? null;
      const next = mergeSnapshot(liveFrom(found.session), cached, found.lastEventSequence);
      const from = cached?.lastEventSequence ?? FROM_THE_START;

      rememberSession(cache.current, requestedSessionId, { live: next, lastEventSequence: from });
      setLoaded({
        sessionId: requestedSessionId,
        detail: found.session,
        from,
        snapshotSequence: found.lastEventSequence,
      });
      setLive(next);
      setLoad('ready');
    } catch (error) {
      if (
        activeSessionId.current !== requestedSessionId ||
        generation !== refreshGeneration.current
      ) {
        return;
      }

      setLoad(error instanceof ApiError && error.code === 'NOT_FOUND' ? 'missing' : 'unreachable');

      if (!(error instanceof NetworkError) && !(error instanceof ApiError)) {
        setLoad('unreachable');
      }
    }
  }, [api, sessionId]);

  useEffect(() => {
    activeSessionId.current = sessionId;
    refreshGeneration.current += 1;
    setConnection('idle');
    setLoadSessionId(sessionId);
    setLoad('loading');
    setLoaded(null);
    setLive(null);

    if (sessionId === null) {
      return;
    }

    void refresh();
  }, [refresh, sessionId]);

  const from = loaded?.from;
  const snapshotSequence = loaded?.snapshotSequence;

  useEffect(() => {
    if (
      from === undefined ||
      snapshotSequence === undefined ||
      sessionId === null ||
      loaded?.sessionId !== sessionId
    ) {
      return;
    }

    const held = new SessionSocket({
      url: `${SOCKET_URL}${SOCKET_PATH}`,
      sessionId,
      lastEventSequence: from,
      open: openSocket,
      onEvents: (envelopes) => {
        if (activeSessionId.current !== sessionId) return;

        setLive((current) => {
          if (current === null) return current;

          const next = applySessionEvents(current, envelopes, snapshotSequence);
          const lastEventSequence =
            envelopes.at(-1)?.sequence ?? cache.current.get(sessionId)?.lastEventSequence ?? from;
          rememberSession(cache.current, sessionId, { live: next, lastEventSequence });
          return next;
        });
      },
      onState: (state) => {
        if (activeSessionId.current === sessionId) setConnection(state);
      },
    });

    held.start();

    return (): void => {
      held.stop();
    };
  }, [from, loaded?.sessionId, sessionId, snapshotSequence]);

  useEffect(() => {
    if (sessionId === null || live === null || TERMINAL_STATUSES.has(live.status)) {
      return;
    }

    const reconcile = async (): Promise<void> => {
      try {
        const found = await api.get(`/sessions/${sessionId}`, SessionDetailResponseSchema);

        if (!TERMINAL_STATUSES.has(found.session.status)) {
          return;
        }

        if (activeSessionId.current !== sessionId) return;

        const cached = cache.current.get(sessionId) ?? null;
        const next = mergeSnapshot(liveFrom(found.session), cached, found.lastEventSequence);
        const from = cached?.lastEventSequence ?? FROM_THE_START;
        rememberSession(cache.current, sessionId, { live: next, lastEventSequence: from });
        setLoaded(() => ({
          sessionId,
          detail: found.session,
          from,
          snapshotSequence: found.lastEventSequence,
        }));
        setLive(next);
      } catch {
        return;
      }
    };

    const interval = window.setInterval(() => {
      void reconcile();
    }, 3_000);

    return (): void => {
      window.clearInterval(interval);
    };
  }, [api, live, sessionId]);

  const change = useCallback(
    (next: (held: LiveSession) => LiveSession): void => {
      if (sessionId === null || activeSessionId.current !== sessionId) return;

      setLive((current) => {
        if (current === null) return current;
        const changed = next(current);
        const lastEventSequence = cache.current.get(sessionId)?.lastEventSequence ?? FROM_THE_START;
        rememberSession(cache.current, sessionId, { live: changed, lastEventSequence });
        return changed;
      });
    },
    [sessionId],
  );

  const current = loaded?.sessionId === sessionId;
  return {
    load: loadSessionId === sessionId ? load : 'loading',
    detail: current ? loaded.detail : null,
    live: current ? live : null,
    connection: current ? connection : 'idle',
    refresh,
    change,
  };
}
