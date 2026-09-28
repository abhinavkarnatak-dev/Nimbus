import {
  CodexAuthStatusSchema,
  CodexDeviceChallengeSchema,
  type CodexDeviceChallenge,
} from '@nimbus/contracts';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import type { ApiClient } from '../api/client.js';

export type CodexAuthState = 'loading' | 'ready' | 'unreachable';

export interface CodexAuthHandle {
  state: CodexAuthState;
  connected: boolean;
  challenge: CodexDeviceChallenge | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: (silent?: boolean) => Promise<void>;
}

export function useCodexAuth(api: ApiClient, enabled: boolean, accountId: string | null): CodexAuthHandle {
  const [state, setState] = useState<CodexAuthState>('loading');
  const [connected, setConnected] = useState(false);
  const [challenge, setChallenge] = useState<CodexDeviceChallenge | null>(null);

  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (!silent) {
      setChallenge(null);
      setState('loading');
    }
    try {
      const status = await api.get('/codex-auth', CodexAuthStatusSchema);
      setConnected(status.connected);
      setState('ready');
    } catch {
      if (!silent) setState('unreachable');
    }
  }, [api]);

  const connect = useCallback(async (): Promise<void> => {
    const next = await api.post('/codex-auth/device', {}, CodexDeviceChallengeSchema);
    setChallenge(next);
    setConnected(false);
    setState('ready');
  }, [api]);

  const disconnect = useCallback(async (): Promise<void> => {
    await api.delete('/codex-auth', z.null());
    setChallenge(null);
    setConnected(false);
  }, [api]);

  useEffect(() => {
    if (!enabled || accountId === null) {
      setChallenge(null);
      setConnected(false);
      setState('loading');
      return;
    }
    void refresh();
  }, [accountId, enabled, refresh]);

  useEffect(() => {
    if (!challenge || connected) return;
    const timer = window.setInterval(() => { void refresh(true); }, 2_000);
    return () => { window.clearInterval(timer); };
  }, [challenge, connected, refresh]);

  useEffect(() => {
    if (connected) setChallenge(null);
  }, [connected]);

  return { state, connected, challenge, connect, disconnect, refresh };
}
