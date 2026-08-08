import { AsyncLocalStorage } from 'node:async_hooks';

import { RequestIdSchema, type RequestId, type SessionId, type UserId } from '@nimbus/contracts';

import { newPrefixedId } from '../lib/id.js';

export interface RequestContext {
  requestId: RequestId;
  userId?: UserId;
  sessionId?: SessionId;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): RequestId {
  return RequestIdSchema.parse(newPrefixedId('req'));
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): RequestId | undefined {
  return storage.getStore()?.requestId;
}

export function attachToRequestContext(fields: Omit<RequestContext, 'requestId'>): void {
  const context = storage.getStore();
  if (context === undefined) {
    return;
  }
  if (fields.userId !== undefined) {
    context.userId = fields.userId;
  }
  if (fields.sessionId !== undefined) {
    context.sessionId = fields.sessionId;
  }
}
