import {
  RepositoriesResponseSchema,
  type InstallationSummary,
  type RepositorySummary,
} from '@nimbus/contracts';
import { useCallback, useEffect, useState } from 'react';

import type { ApiClient } from '../api/client.js';
import { gateFrom, gateFromFailure, type GateState } from './installation.js';

export interface InstallationHandle {
  gate: GateState;
  installation: InstallationSummary | null;
  repositories: readonly RepositorySummary[];
  refresh: () => Promise<void>;
}

export function useInstallation(api: ApiClient, enabled: boolean): InstallationHandle {
  const [gate, setGate] = useState<GateState>('checking');
  const [installation, setInstallation] = useState<InstallationSummary | null>(null);
  const [repositories, setRepositories] = useState<readonly RepositorySummary[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const found = await api.get('/github/repositories', RepositoriesResponseSchema);
      setInstallation(found.installation);
      setRepositories(found.repositories);
      setGate(gateFrom(found));
    } catch (error) {
      setInstallation(null);
      setRepositories([]);
      setGate(gateFromFailure(error));
    }
  }, [api]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { gate, installation, repositories, refresh };
}
