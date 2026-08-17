import type { InstallationSummary } from '@nimbus/contracts';

import { ApiError, NetworkError } from '../api/errors.js';

export function manageUrl(installation: InstallationSummary): string {
  const id = String(installation.installationId);

  return installation.accountType === 'Organization'
    ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

export function disconnectProblem(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'Nimbus is not answering. Check your connection and try again.';
  }

  if (error instanceof ApiError && error.code === 'GITHUB_NOT_CONNECTED') {
    return 'There is no GitHub connection to remove.';
  }
  return 'That did not disconnect. Try again.';
}

export function disconnectWords(uninstalledOnGitHub: boolean): string {
  return uninstalledOnGitHub
    ? 'GitHub is disconnected and the Nimbus app was uninstalled.'
    : 'Nimbus forgot the connection. The app is still installed on GitHub, so remove it there too.';
}

export function repositoriesUpdated(search: string): boolean {
  return new URLSearchParams(search).get('github') === 'updated';
}
