import type { Db } from 'mongodb';

import {
  auditEventsCollection,
  buildAuditEvent,
  type AuditEventInput,
} from '../db/models/audit-event.js';
import type { Logger } from '../logging/logger.js';

export async function recordAuditEvent(
  db: Db,
  logger: Logger,
  input: AuditEventInput,
): Promise<void> {
  try {
    await auditEventsCollection(db).insertOne(buildAuditEvent(input));
  } catch (error) {
    logger.error({ action: input.action, err: error }, 'Could not write an audit event');
  }
}
