import type { AuditEventInput } from '../db/models/audit-event.js';
import type { Logger } from '../logging/logger.js';
import { SANDBOX_LIMITS } from './limits.js';
import {
  SandboxError,
  describeSandboxForLog,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
  type SandboxTerminationReason,
} from './provider.js';

export type SandboxAuditRecorder = (input: AuditEventInput) => Promise<void>;

export interface SandboxRunOptions {
  provider: SandboxProvider;
  spec: SandboxSpec;
  logger: Logger;
  signal?: AbortSignal;
  audit?: SandboxAuditRecorder;
  userId?: string | null;
  terminateTimeoutMs?: number;
}

async function withTimeout<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SandboxError('SANDBOX_TERMINATE_FAILED', message));
    }, milliseconds);
  });

  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function record(
  options: SandboxRunOptions,
  input: Omit<AuditEventInput, 'actorType'>,
): Promise<void> {
  if (options.audit === undefined) {
    return;
  }

  try {
    await options.audit({
      ...input,
      actorType: 'system',
      sessionId: options.spec.sessionId,
      userId: options.userId ?? null,
    });
  } catch (error) {
    options.logger.error({ err: error }, 'Could not record a sandbox audit event');
  }
}

async function terminateQuietly(
  sandbox: Sandbox,
  reason: SandboxTerminationReason,
  options: SandboxRunOptions,
): Promise<unknown> {
  try {
    await withTimeout(
      sandbox.terminate(reason),
      options.terminateTimeoutMs ?? SANDBOX_LIMITS.terminateTimeoutMs,
      'The sandbox did not shut down in time.',
    );

    options.logger.info(
      { ...describeSandboxForLog(sandbox.status()), reason },
      'Destroyed a sandbox',
    );
    await record(options, {
      action: 'sandbox.destroyed',
      outcome: 'success',
      reason,
      metadata: { sandboxId: sandbox.sandboxId, provider: options.provider.name },
    });
    return undefined;
  } catch (error) {
    options.logger.error(
      { sandboxId: sandbox.sandboxId, reason, err: error },
      'Could not destroy a sandbox',
    );
    await record(options, {
      action: 'sandbox.destroyed',
      outcome: 'failure',
      reason,
      metadata: { sandboxId: sandbox.sandboxId, provider: options.provider.name },
    });
    return error;
  }
}

export async function withSandbox<T>(
  options: SandboxRunOptions,
  work: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  let sandbox: Sandbox;

  try {
    sandbox = await options.provider.create(options.spec);
  } catch (error) {
    options.logger.error({ err: error }, 'Could not create a sandbox');
    await record(options, {
      action: 'sandbox.created',
      outcome: 'failure',
      metadata: { provider: options.provider.name },
    });
    throw error;
  }

  options.logger.info(
    { ...describeSandboxForLog(sandbox.status()), provider: options.provider.name },
    'Created a sandbox',
  );
  await record(options, {
    action: 'sandbox.created',
    outcome: 'success',
    metadata: { sandboxId: sandbox.sandboxId, provider: options.provider.name },
  });

  let failure: { thrown: unknown } | undefined;
  let result: T | undefined;
  let reason: SandboxTerminationReason = 'completed';

  try {
    result = await work(sandbox);
  } catch (error) {
    failure = { thrown: error };
    reason = options.signal?.aborted === true ? 'cancelled' : 'failed';
  }

  if (failure === undefined && options.signal?.aborted === true) {
    reason = 'cancelled';
  }

  const teardownError = await terminateQuietly(sandbox, reason, options);

  if (failure !== undefined) {
    throw failure.thrown as Error;
  }

  if (teardownError !== undefined) {
    throw new SandboxError('SANDBOX_TERMINATE_FAILED', 'The sandbox could not be shut down.', {
      cause: teardownError,
    });
  }
  return result as T;
}
