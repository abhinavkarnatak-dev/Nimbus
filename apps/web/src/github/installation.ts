import type { ErrorCode, InstallationStatus, RepositoriesResponse } from '@nimbus/contracts';

import { ApiError, NetworkError } from '../api/errors.js';

export type GateState =
  'checking' | 'never_connected' | 'active' | 'suspended' | 'removed' | 'unreachable';

export const OPEN_GATE_STATES: readonly GateState[] = ['active'];

export function gateFrom(response: RepositoriesResponse): GateState {
  const installation = response.installation;

  if (installation === null) {
    return 'never_connected';
  }

  const byStatus: Readonly<Record<InstallationStatus, GateState>> = {
    active: 'active',
    suspended: 'suspended',
    removed: 'removed',
  };

  return byStatus[installation.status];
}

export function gateFromFailure(error: unknown): GateState {
  if (error instanceof ApiError && error.code === 'GITHUB_NOT_CONNECTED') {
    return 'never_connected';
  }

  if (error instanceof ApiError && error.code === 'GITHUB_INSTALLATION_SUSPENDED') {
    return 'suspended';
  }
  return 'unreachable';
}

export function gateIsOpen(state: GateState): boolean {
  return OPEN_GATE_STATES.includes(state);
}

export const SETUP_OUTCOMES = ['connected', 'cancelled', 'failed'] as const;

export type SetupOutcome = (typeof SETUP_OUTCOMES)[number];

export interface SetupResult {
  outcome: SetupOutcome;
  reason: string | null;
}

export function readSetupResult(search: string): SetupResult | null {
  const params = new URLSearchParams(search);
  const outcome = params.get('github');

  if (outcome === null || !SETUP_OUTCOMES.includes(outcome as SetupOutcome)) {
    return null;
  }

  return { outcome: outcome as SetupOutcome, reason: params.get('reason') };
}

const SETUP_REASONS: Partial<Record<ErrorCode, string>> = {
  OAUTH_STATE_INVALID: 'That connection link had expired. Start again from here.',
  GITHUB_NOT_CONNECTED:
    'The Nimbus app is not installed on that GitHub account yet. Authorizing is not the same as installing, so do step 1 first.',
  GITHUB_INSTALLATION_SUSPENDED: 'That installation is suspended on GitHub.',
  FORBIDDEN: 'That installation belongs to somebody else.',
};

export function setupWords(result: SetupResult): { tone: 'good' | 'plain' | 'bad'; text: string } {
  if (result.outcome === 'connected') {
    return { tone: 'good', text: 'GitHub is connected.' };
  }

  if (result.outcome === 'cancelled') {
    return { tone: 'plain', text: 'You stopped before finishing. Nothing was connected.' };
  }

  const known = result.reason === null ? undefined : SETUP_REASONS[result.reason as ErrorCode];

  return { tone: 'bad', text: known ?? 'That connection did not finish. Try again.' };
}

export function connectProblem(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'Nimbus is not answering. Check your connection and try again.';
  }

  if (error instanceof ApiError && error.code === 'AGENT_SESSIONS_DISABLED') {
    return 'GitHub connection is switched off on this deployment.';
  }
  return 'That did not start. Try again.';
}
