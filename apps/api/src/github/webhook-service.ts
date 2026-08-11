import type { InstallationStatus } from '@nimbus/contracts';
import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';
import { z } from 'zod';

import { recordAuditEvent } from '../auth/audit.js';
import type { GitHubConfig } from '../config/load.js';
import type { AuditAction } from '../db/models/audit-event.js';
import {
  githubInstallationsCollection,
  type GitHubInstallationDocument,
  type SelectedRepository,
} from '../db/models/github-installation.js';
import { ApiError } from '../http/api-error.js';
import type { Logger } from '../logging/logger.js';
import { IdempotencyStore } from '../redis/idempotency.js';
import {
  MAX_WEBHOOK_REPOSITORIES,
  decideWebhookIntent,
  parseWebhookBody,
  type WebhookIntent,
} from './webhook-events.js';
import {
  isWellFormedDeliveryId,
  isWellFormedEventName,
  verifySignature,
} from './webhook-signature.js';

export const DELIVERY_RUNNING_TTL_SECONDS = 60;
export const DELIVERY_COMPLETED_TTL_SECONDS = 86_400;

const HandledResultSchema = z.strictObject({
  outcome: z.enum(['applied', 'ignored']),
  reason: z.string().max(200),
});

type HandledResult = z.infer<typeof HandledResultSchema>;

export type WebhookOutcome = 'applied' | 'ignored' | 'duplicate' | 'in_progress';

export interface WebhookResult {
  outcome: WebhookOutcome;
  reason: string;
}

export interface WebhookDelivery {
  event: string;
  deliveryId: string;
  signature: string;
  body: Buffer;
  ip: string;
}

export interface GitHubWebhookServiceOptions {
  redis: Redis;
  db: Db;
  github: GitHubConfig;
  logger: Logger;
  runningTtlSeconds?: number;
  completedTtlSeconds?: number;
}

const STATUS_ACTIONS: Record<InstallationStatus, AuditAction> = {
  active: 'github.installation.unsuspended',
  suspended: 'github.installation.suspended',
  removed: 'github.installation.removed',
};

export function mergeSelectedRepositories(
  existing: readonly SelectedRepository[],
  added: readonly SelectedRepository[],
  removed: readonly number[],
): SelectedRepository[] {
  const dropped = new Set(removed);
  const merged: SelectedRepository[] = [];
  const seen = new Set<number>();

  for (const repository of [...existing, ...added]) {
    if (dropped.has(repository.repositoryId) || seen.has(repository.repositoryId)) {
      continue;
    }
    seen.add(repository.repositoryId);
    merged.push(repository);

    if (merged.length >= MAX_WEBHOOK_REPOSITORIES) {
      break;
    }
  }

  return merged;
}

export class GitHubWebhookService {
  private readonly db: Db;
  private readonly github: GitHubConfig;
  private readonly logger: Logger;
  private readonly deliveries: IdempotencyStore<HandledResult>;

  constructor(options: GitHubWebhookServiceOptions) {
    this.db = options.db;
    this.github = options.github;
    this.logger = options.logger;
    this.deliveries = new IdempotencyStore(options.redis, {
      schema: HandledResultSchema,
      runningTtlSeconds: options.runningTtlSeconds ?? DELIVERY_RUNNING_TTL_SECONDS,
      completedTtlSeconds: options.completedTtlSeconds ?? DELIVERY_COMPLETED_TTL_SECONDS,
      logger: options.logger,
    });
  }

  async handle(delivery: WebhookDelivery): Promise<WebhookResult> {
    if (!verifySignature(this.github.webhookSecret, delivery.body, delivery.signature)) {
      this.logger.warn(
        { event: delivery.event, ip: delivery.ip, signed: delivery.signature !== '' },
        'Refused a GitHub webhook with a missing or invalid signature',
      );
      throw new ApiError('UNAUTHENTICATED', 'That request could not be verified.');
    }

    if (!isWellFormedEventName(delivery.event) || !isWellFormedDeliveryId(delivery.deliveryId)) {
      throw new ApiError('VALIDATION_FAILED', 'That webhook delivery could not be read.');
    }

    const payload = parseWebhookBody(delivery.body);
    if (payload === null) {
      throw new ApiError('VALIDATION_FAILED', 'That webhook delivery could not be read.');
    }

    const intent = decideWebhookIntent(delivery.event, payload);
    if (intent.kind === 'ignore') {
      this.logger.debug(
        { event: delivery.event, deliveryId: delivery.deliveryId, reason: intent.reason },
        'Ignored a GitHub webhook',
      );
      return { outcome: 'ignored', reason: intent.reason };
    }

    const claim = await this.deliveries.begin(delivery.deliveryId);

    if (claim.status === 'completed') {
      return { outcome: 'duplicate', reason: claim.result.reason };
    }
    if (claim.status === 'running') {
      return { outcome: 'in_progress', reason: 'delivery_already_being_handled' };
    }

    try {
      const result = await this.apply(intent, delivery);
      await this.deliveries.complete(delivery.deliveryId, result);
      return result;
    } catch (error) {
      await this.deliveries.abandon(delivery.deliveryId);
      throw error;
    }
  }

  private async apply(intent: WebhookIntent, delivery: WebhookDelivery): Promise<HandledResult> {
    if (intent.kind === 'ignore') {
      return { outcome: 'ignored', reason: intent.reason };
    }

    const collection = githubInstallationsCollection(this.db);
    const record = await collection.findOne({ installationId: intent.installationId });

    if (record === null) {
      this.logger.info(
        { event: delivery.event, installationId: intent.installationId },
        'Ignored a GitHub webhook for an installation Nimbus does not hold',
      );
      return { outcome: 'ignored', reason: 'unknown_installation' };
    }

    if (intent.kind === 'touch') {
      await collection.updateOne(
        { installationId: intent.installationId },
        { $set: { updatedAt: new Date() } },
      );
      await this.audit(record, 'github.installation.permissions_accepted', delivery, {});
      return { outcome: 'applied', reason: 'permissions_accepted' };
    }

    if (intent.kind === 'status') {
      return this.applyStatus(record, intent.status, delivery);
    }

    return this.applyRepositories(record, intent, delivery);
  }

  private async applyStatus(
    record: GitHubInstallationDocument,
    status: InstallationStatus,
    delivery: WebhookDelivery,
  ): Promise<HandledResult> {
    if (record.status === 'removed' && status !== 'removed') {
      this.logger.warn(
        { installationId: record.installationId, status },
        'Refused to revive a removed installation from a webhook',
      );
      return { outcome: 'ignored', reason: 'installation_already_removed' };
    }

    const now = new Date();

    await githubInstallationsCollection(this.db).updateOne(
      { installationId: record.installationId },
      {
        $set:
          status === 'removed'
            ? { status, removedAt: now, updatedAt: now }
            : { status, updatedAt: now },
      },
    );

    await this.audit(record, STATUS_ACTIONS[status], delivery, { previousStatus: record.status });

    this.logger.info(
      {
        installationId: record.installationId,
        deliveryId: delivery.deliveryId,
        from: record.status,
        to: status,
      },
      'Applied a GitHub installation lifecycle event',
    );

    return { outcome: 'applied', reason: `status_${status}` };
  }

  private async applyRepositories(
    record: GitHubInstallationDocument,
    intent: Extract<WebhookIntent, { kind: 'repositories' }>,
    delivery: WebhookDelivery,
  ): Promise<HandledResult> {
    const selectedRepositories = intent.selectsAll
      ? []
      : mergeSelectedRepositories(record.selectedRepositories, intent.added, intent.removed);

    await githubInstallationsCollection(this.db).updateOne(
      { installationId: record.installationId },
      { $set: { selectedRepositories, updatedAt: new Date() } },
    );

    await this.audit(record, 'github.repositories.changed', delivery, {
      added: intent.added.length,
      removed: intent.removed.length,
      selectsAll: intent.selectsAll,
      stored: selectedRepositories.length,
    });

    this.logger.info(
      {
        installationId: record.installationId,
        deliveryId: delivery.deliveryId,
        added: intent.added.length,
        removed: intent.removed.length,
        stored: selectedRepositories.length,
      },
      'Updated the repositories stored for an installation',
    );

    return {
      outcome: 'applied',
      reason: intent.selectsAll ? 'selects_all' : 'repositories_changed',
    };
  }

  private async audit(
    record: GitHubInstallationDocument,
    action: AuditAction,
    delivery: WebhookDelivery,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await recordAuditEvent(this.db, this.logger, {
      action,
      outcome: 'success',
      actorType: 'webhook',
      userId: record.userId,
      installationRecordId: record.installationRecordId,
      metadata: { ...metadata, event: delivery.event, deliveryId: delivery.deliveryId },
    });
  }
}
