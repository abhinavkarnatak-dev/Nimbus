import {
  GitHubInstallationIdSchema,
  GitHubRepositoryIdSchema,
  RepositoryNameSchema,
  RepositoryOwnerSchema,
  type InstallationStatus,
} from '@nimbus/contracts';
import { z } from 'zod';

import type { SelectedRepository } from '../db/models/github-installation.js';

export const INSTALLATION_EVENT = 'installation';
export const INSTALLATION_REPOSITORIES_EVENT = 'installation_repositories';
export const MAX_WEBHOOK_REPOSITORIES = 500;

const WebhookInstallationSchema = z.object({
  id: GitHubInstallationIdSchema,
  repository_selection: z.string().optional(),
});

export const InstallationEventSchema = z.object({
  action: z.string().min(1).max(64),
  installation: WebhookInstallationSchema,
});

export const InstallationRepositoriesEventSchema = z.object({
  action: z.string().min(1).max(64),
  installation: WebhookInstallationSchema,
  repository_selection: z.string().optional(),
  repositories_added: z.array(z.unknown()).max(5000).optional(),
  repositories_removed: z.array(z.unknown()).max(5000).optional(),
});

export interface WebhookRepositoryPayload {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  private?: unknown;
}

export type WebhookIntent =
  | { kind: 'ignore'; reason: string }
  | { kind: 'status'; installationId: number; status: InstallationStatus }
  | { kind: 'touch'; installationId: number }
  | {
      kind: 'repositories';
      installationId: number;
      added: SelectedRepository[];
      removed: number[];
      selectsAll: boolean;
    };

export function parseWebhookBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asPayload(value: unknown): WebhookRepositoryPayload | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

export function toSelectedRepository(value: unknown): SelectedRepository | null {
  const payload = asPayload(value);

  if (payload?.private !== false || typeof payload.full_name !== 'string') {
    return null;
  }

  const separator = payload.full_name.indexOf('/');
  if (separator <= 0) {
    return null;
  }

  const parsed = z
    .strictObject({
      repositoryId: GitHubRepositoryIdSchema,
      owner: RepositoryOwnerSchema,
      name: RepositoryNameSchema,
    })
    .safeParse({
      repositoryId: payload.id,
      owner: payload.full_name.slice(0, separator),
      name: payload.name,
    });

  return parsed.success ? parsed.data : null;
}

export function toSelectedRepositories(payloads: readonly unknown[]): SelectedRepository[] {
  const selected: SelectedRepository[] = [];
  const seen = new Set<number>();

  for (const payload of payloads) {
    const repository = toSelectedRepository(payload);

    if (repository === null || seen.has(repository.repositoryId)) {
      continue;
    }
    seen.add(repository.repositoryId);
    selected.push(repository);

    if (selected.length >= MAX_WEBHOOK_REPOSITORIES) {
      break;
    }
  }

  return selected;
}

export function toRemovedRepositoryIds(payloads: readonly unknown[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();

  for (const value of payloads) {
    const parsed = GitHubRepositoryIdSchema.safeParse(asPayload(value)?.id);

    if (!parsed.success || seen.has(parsed.data)) {
      continue;
    }
    seen.add(parsed.data);
    ids.push(parsed.data);
  }

  return ids;
}

function installationIntent(payload: Record<string, unknown>): WebhookIntent {
  const parsed = InstallationEventSchema.safeParse(payload);

  if (!parsed.success) {
    return { kind: 'ignore', reason: 'unreadable_installation_payload' };
  }

  const installationId = parsed.data.installation.id;

  switch (parsed.data.action) {
    case 'suspend':
      return { kind: 'status', installationId, status: 'suspended' };
    case 'unsuspend':
      return { kind: 'status', installationId, status: 'active' };
    case 'deleted':
      return { kind: 'status', installationId, status: 'removed' };
    case 'new_permissions_accepted':
      return { kind: 'touch', installationId };
    case 'created':
      return { kind: 'ignore', reason: 'installation_created_needs_a_signed_in_owner' };
    default:
      return { kind: 'ignore', reason: 'unhandled_installation_action' };
  }
}

function repositoriesIntent(payload: Record<string, unknown>): WebhookIntent {
  const parsed = InstallationRepositoriesEventSchema.safeParse(payload);

  if (!parsed.success) {
    return { kind: 'ignore', reason: 'unreadable_repositories_payload' };
  }

  if (parsed.data.action !== 'added' && parsed.data.action !== 'removed') {
    return { kind: 'ignore', reason: 'unhandled_repositories_action' };
  }

  const selection =
    parsed.data.repository_selection ?? parsed.data.installation.repository_selection;

  return {
    kind: 'repositories',
    installationId: parsed.data.installation.id,
    added: toSelectedRepositories(parsed.data.repositories_added ?? []),
    removed: toRemovedRepositoryIds(parsed.data.repositories_removed ?? []),
    selectsAll: selection === 'all',
  };
}

export function decideWebhookIntent(
  event: string,
  payload: Record<string, unknown>,
): WebhookIntent {
  if (event === INSTALLATION_EVENT) {
    return installationIntent(payload);
  }
  if (event === INSTALLATION_REPOSITORIES_EVENT) {
    return repositoriesIntent(payload);
  }
  return { kind: 'ignore', reason: 'unhandled_event' };
}
