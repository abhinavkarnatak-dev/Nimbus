import { describe, expect, it } from 'vitest';

import type { AuditEventInput } from '../db/models/audit-event.js';
import { createTestLogger } from '../http/http.fixtures.js';
import { FakeSandboxProvider } from './fake-provider.js';
import { withSandbox, type SandboxAuditRecorder, type SandboxRunOptions } from './lifecycle.js';
import {
  SandboxError,
  type CommandResult,
  type PatchExport,
  type Sandbox,
  type SandboxStatus,
  type SandboxTerminationReason,
  type WorkspaceEntry,
} from './provider.js';
import { testSpec } from './sandbox.fixtures.js';

function collector(): { audit: SandboxAuditRecorder; entries: AuditEventInput[] } {
  const entries: AuditEventInput[] = [];

  return {
    entries,
    audit: async (input) => {
      entries.push(input);
      await Promise.resolve();
    },
  };
}

function actions(entries: readonly AuditEventInput[]): string[] {
  return entries.map((entry) => `${entry.action}:${entry.outcome}`);
}

class StubSandbox implements Sandbox {
  readonly sandboxId = 'sbx_stubstubstubstubstu';

  terminateCalls = 0;

  constructor(private readonly onTerminate: () => Promise<void>) {}

  status(): SandboxStatus {
    const createdAt = new Date();

    return {
      sandboxId: this.sandboxId,
      state: 'ready',
      createdAt,
      deadlineAt: new Date(createdAt.getTime() + 1_000),
      remainingMs: 1_000,
      commandsRun: 0,
      outputBytesUsed: 0,
      terminatedAt: null,
      terminationReason: null,
    };
  }

  async execute(): Promise<CommandResult> {
    return await Promise.reject(new Error('not used'));
  }

  async listEntries(): Promise<WorkspaceEntry[]> {
    return await Promise.reject(new Error('not used'));
  }

  async readFile(): Promise<string> {
    return await Promise.reject(new Error('not used'));
  }

  async writeFile(): Promise<void> {
    await Promise.reject(new Error('not used'));
  }

  async removeFile(): Promise<void> {
    await Promise.reject(new Error('not used'));
  }

  async markBaseline(): Promise<void> {
    await Promise.reject(new Error('not used'));
  }

  async exportPatch(): Promise<PatchExport> {
    return await Promise.reject(new Error('not used'));
  }

  async terminate(_reason: SandboxTerminationReason): Promise<void> {
    this.terminateCalls += 1;
    await this.onTerminate();
  }
}

function stubProvider(sandbox: Sandbox): SandboxRunOptions['provider'] {
  return {
    name: 'sandbox-stub',
    real: false,
    create: async () => await Promise.resolve(sandbox),
  };
}

function options(overrides: Partial<SandboxRunOptions> = {}): SandboxRunOptions {
  const { logger } = createTestLogger();

  return {
    provider: new FakeSandboxProvider(),
    spec: testSpec(),
    logger,
    ...overrides,
  };
}

describe('withSandbox on the happy path', () => {
  it('gives the work a ready sandbox and returns its result', async () => {
    const result = await withSandbox(options(), async (sandbox) => {
      expect(sandbox.status().state).toBe('ready');
      return await Promise.resolve('finished');
    });

    expect(result).toBe('finished');
  });

  it('destroys the sandbox afterwards', async () => {
    const provider = new FakeSandboxProvider();
    await withSandbox(options({ provider }), async () => await Promise.resolve(1));

    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]?.status().state).toBe('terminated');
    expect(provider.created[0]?.status().terminationReason).toBe('completed');
    expect(provider.liveCount).toBe(0);
  });

  it('returns undefined work results without treating them as a failure', async () => {
    await expect(
      withSandbox(options(), async () => {
        await Promise.resolve(undefined);
      }),
    ).resolves.toBeUndefined();
  });
});

describe('withSandbox when the work fails', () => {
  it('still destroys the sandbox', async () => {
    const provider = new FakeSandboxProvider();

    await expect(
      withSandbox(options({ provider }), async () => {
        await Promise.resolve();
        throw new Error('the work went wrong');
      }),
    ).rejects.toThrow('the work went wrong');

    expect(provider.created[0]?.status().state).toBe('terminated');
    expect(provider.created[0]?.status().terminationReason).toBe('failed');
  });

  it('lets the original error through untouched', async () => {
    const original = new SandboxError('SANDBOX_COMMAND_INVALID', 'bad command');

    await expect(
      withSandbox(options(), async () => {
        await Promise.resolve();
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('records the reason as cancelled when the signal was raised', async () => {
    const provider = new FakeSandboxProvider();
    const controller = new AbortController();

    await expect(
      withSandbox(options({ provider, signal: controller.signal }), async () => {
        controller.abort();
        await Promise.resolve();
        throw new Error('stopped');
      }),
    ).rejects.toThrow('stopped');

    expect(provider.created[0]?.status().terminationReason).toBe('cancelled');
  });

  it('records the reason as cancelled even when the work returned quietly', async () => {
    const provider = new FakeSandboxProvider();
    const controller = new AbortController();

    await withSandbox(options({ provider, signal: controller.signal }), async () => {
      controller.abort();
      return await Promise.resolve('done anyway');
    });

    expect(provider.created[0]?.status().terminationReason).toBe('cancelled');
  });
});

describe('withSandbox when destroying fails', () => {
  it('never lets a cleanup error hide the real error', async () => {
    const provider = new FakeSandboxProvider({ terminateFails: new Error('cleanup exploded') });

    await expect(
      withSandbox(options({ provider }), async () => {
        await Promise.resolve();
        throw new Error('the real problem');
      }),
    ).rejects.toThrow('the real problem');
  });

  it('surfaces the cleanup failure when there was no other error to report', async () => {
    const provider = new FakeSandboxProvider({ terminateFails: new Error('cleanup exploded') });

    await expect(
      withSandbox(options({ provider }), async () => await Promise.resolve('fine')),
    ).rejects.toThrow(SandboxError);
  });

  it('names the cause so the original cleanup failure is still readable', async () => {
    const cause = new Error('provider unreachable');
    const provider = new FakeSandboxProvider({ terminateFails: cause });

    const error = await withSandbox(
      options({ provider }),
      async () => await Promise.resolve('fine'),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).code).toBe('SANDBOX_TERMINATE_FAILED');
    expect((error as SandboxError).cause).toBe(cause);
  });

  it('gives up on a shutdown that never finishes', async () => {
    const sandbox = new StubSandbox(async () => {
      await new Promise<void>(() => undefined);
    });

    await expect(
      withSandbox(
        options({ provider: stubProvider(sandbox), terminateTimeoutMs: 20 }),
        async () => await Promise.resolve('fine'),
      ),
    ).rejects.toThrow(/could not be shut down/);
    expect(sandbox.terminateCalls).toBe(1);
  });

  it('logs a cleanup failure as an error', async () => {
    const { logger, lines } = createTestLogger();
    const provider = new FakeSandboxProvider({ terminateFails: new Error('cleanup exploded') });

    await withSandbox(options({ provider, logger }), async () => await Promise.resolve(1)).catch(
      () => undefined,
    );

    expect(lines.some((line) => line.msg === 'Could not destroy a sandbox')).toBe(true);
  });
});

describe('withSandbox when creating fails', () => {
  it('lets the error through and has nothing to clean up', async () => {
    const provider = new FakeSandboxProvider({
      createFails: new SandboxError('SANDBOX_CREATE_FAILED', 'No capacity.'),
    });

    await expect(
      withSandbox(options({ provider }), async () => await Promise.resolve(1)),
    ).rejects.toThrow('No capacity.');
    expect(provider.created).toHaveLength(0);
  });

  it('never runs the work', async () => {
    let ran = false;
    const provider = new FakeSandboxProvider({
      createFails: new SandboxError('SANDBOX_CREATE_FAILED', 'No capacity.'),
    });

    await withSandbox(options({ provider }), async () => {
      ran = true;
      return await Promise.resolve(1);
    }).catch(() => undefined);

    expect(ran).toBe(false);
  });
});

describe('withSandbox audit trail', () => {
  it('records the sandbox being created and destroyed', async () => {
    const { audit, entries } = collector();
    await withSandbox(options({ audit }), async () => await Promise.resolve(1));

    expect(actions(entries)).toEqual(['sandbox.created:success', 'sandbox.destroyed:success']);
    expect(entries[1]?.reason).toBe('completed');
  });

  it('attributes the entries to the system and the session', async () => {
    const { audit, entries } = collector();
    await withSandbox(
      options({ audit, userId: 'usr_0123456789abcdefghijk' }),
      async () => await Promise.resolve(1),
    );

    expect(entries[0]).toMatchObject({
      actorType: 'system',
      sessionId: testSpec().sessionId,
      userId: 'usr_0123456789abcdefghijk',
    });
  });

  it('records a failed creation', async () => {
    const { audit, entries } = collector();
    const provider = new FakeSandboxProvider({
      createFails: new SandboxError('SANDBOX_CREATE_FAILED', 'No capacity.'),
    });

    await withSandbox(options({ provider, audit }), async () => await Promise.resolve(1)).catch(
      () => undefined,
    );

    expect(actions(entries)).toEqual(['sandbox.created:failure']);
  });

  it('records a failed teardown, which is what a sweeper would look for', async () => {
    const { audit, entries } = collector();
    const provider = new FakeSandboxProvider({ terminateFails: new Error('cleanup exploded') });

    await withSandbox(options({ provider, audit }), async () => await Promise.resolve(1)).catch(
      () => undefined,
    );

    expect(actions(entries)).toEqual(['sandbox.created:success', 'sandbox.destroyed:failure']);
  });

  it('keeps going when writing the audit entry itself fails', async () => {
    const { logger, lines } = createTestLogger();
    const provider = new FakeSandboxProvider();

    const result = await withSandbox(
      options({
        provider,
        logger,
        audit: async () => {
          await Promise.reject(new Error('mongo is down'));
        },
      }),
      async () => await Promise.resolve('still fine'),
    );

    expect(result).toBe('still fine');
    expect(provider.created[0]?.status().state).toBe('terminated');
    expect(lines.some((line) => line.msg === 'Could not record a sandbox audit event')).toBe(true);
  });
});

describe('what the sandbox logs say', () => {
  it('names the sandbox and its state without describing the work', async () => {
    const { logger, lines } = createTestLogger();
    await withSandbox(options({ logger }), async () => await Promise.resolve(1));

    const created = lines.find((line) => line.msg === 'Created a sandbox');
    const destroyed = lines.find((line) => line.msg === 'Destroyed a sandbox');

    expect(created?.['sandboxId']).toMatch(/^sbx_/);
    expect(created?.['provider']).toBe('sandbox-fake');
    expect(destroyed?.['reason']).toBe('completed');
    expect(destroyed?.['state']).toBe('terminated');
  });

  it('never writes the environment or template the sandbox was given', async () => {
    const { logger, lines } = createTestLogger();
    const spec = testSpec({
      templateId: 'template-marker',
      env: { CI: 'true', TZ: 'zone-marker' },
    });

    await withSandbox(options({ logger, spec }), async () => await Promise.resolve(1));

    const written = JSON.stringify(lines);

    expect(written).not.toContain('template-marker');
    expect(written).not.toContain('zone-marker');
    expect(written).not.toContain('"env"');
    expect(written).not.toMatch(/token|secret|password/i);
  });
});
