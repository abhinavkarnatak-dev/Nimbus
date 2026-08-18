import type { ModelPlan } from '@nimbus/contracts';
import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { InMemoryAttachmentRecords } from '../attachments/repository.js';
import { minimalEnv } from '../config/env.fixtures.js';
import { DEFAULT_LIMITS } from '../config/limits.js';
import { loadConfig } from '../config/load.js';
import type { AttachmentDocument } from '../db/models/attachment.js';
import type { SessionDocument } from '../db/models/session.js';
import { FakeGitHubTokenProvider } from '../github/fake-token-provider.js';
import { FakeTextProvider } from '../llm/fake-text.js';
import { FakeVisionProvider } from '../llm/fake-vision.js';
import { capturingLogger } from '../llm/llm.fixtures.js';
import { DEFAULT_TEXT_MODEL, findModel } from '../llm/models.js';
import { everyProviderKey, fixedText } from '../llm/sources.js';
import { SessionAttachments } from '../routing/attached.js';
import { ImageDescriber, fixedDescriber } from '../routing/describe.js';
import { FakeImageBytes, attachment, textAttachment } from '../routing/routing.fixtures.js';
import { SELECTABLE_TEXT_MODELS } from '../routing/selection.js';
import { FakeSandboxProvider } from '../sandbox/fake-provider.js';
import type { SandboxProvider } from '../sandbox/provider.js';
import { InMemorySessionRecords } from '../sessions/repository.js';
import { LiveSessionWorkshop, type BaseCommitResolver } from './live-workshop.js';
import { sessionDocument } from './orchestrator.fixtures.js';

const NO_DATABASE = {} as unknown as Db;
const ORIGINAL_SHA = '1'.repeat(40);
const MOVED_SHA = '2'.repeat(40);

function listed(document: AttachmentDocument): SessionDocument['attachments'][number] {
  return {
    attachmentId: document.attachmentId,
    kind: document.kind,
    mimeType: document.mimeType,
    byteSize: document.byteSize,
    originalName: document.originalName,
    createdAt: document.createdAt,
  };
}

async function workshopFor(
  documents: readonly AttachmentDocument[],
  options: {
    vision?: FakeVisionProvider;
    wired?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<{
  session: SessionDocument;
  workshop: LiveSessionWorkshop;
  vision: FakeVisionProvider;
}> {
  const session = sessionDocument();
  const owned = documents.map((one) => ({ ...one, userId: session.userId }));
  const records = new InMemoryAttachmentRecords();
  const captured = capturingLogger();
  const vision = options.vision ?? new FakeVisionProvider();
  const bytes = new FakeImageBytes();

  for (const document of owned) {
    await records.insert(document);
  }

  const attachments = new SessionAttachments({
    records,
    bytes,
    describers: fixedDescriber(
      new ImageDescriber({ vision, records, bytes, logger: captured.logger }),
    ),
    logger: captured.logger,
  });

  return {
    vision,
    session: { ...session, attachments: owned.map(listed) },
    workshop: new LiveSessionWorkshop({
      db: NO_DATABASE,
      installations: { activeInstallation: async () => Promise.resolve({ installationId: 4_242 }) },
      tokens: new FakeGitHubTokenProvider(),
      sandboxes: new FakeSandboxProvider({ files: {} }),
      text: fixedText(new FakeTextProvider({ answers: [] })),
      providerKeys: everyProviderKey(),
      config: loadConfig({ ...minimalEnv(), ...options.env }),
      logger: captured.logger,
      ...(options.wired === false ? {} : { attachments }),
    }),
  };
}

describe('a run prepared for a session that has attachments', () => {
  it('carries the description of a picture into the run', async () => {
    const held = await workshopFor([attachment()], {
      vision: new FakeVisionProvider({
        descriptions: [{ description: 'a dashboard with an empty orders table' }],
      }),
    });

    const prepared = await held.workshop.prepare(held.session, {
      signal: new AbortController().signal,
    });

    expect(prepared.input.images?.[0]?.description).toBe('a dashboard with an empty orders table');
    await prepared.finish();
  });

  it('carries an attached file into the run under its own name', async () => {
    const held = await workshopFor([textAttachment({ originalName: 'failing-test.txt' })]);

    const prepared = await held.workshop.prepare(held.session, {
      signal: new AbortController().signal,
    });

    expect(prepared.input.attachments?.[0]?.name).toBe('failing-test.txt');
    await prepared.finish();
  });

  it('charges what the description cost to the session, not to nobody', async () => {
    const held = await workshopFor([attachment()]);

    const prepared = await held.workshop.prepare(held.session, {
      signal: new AbortController().signal,
    });

    const spent = prepared.input.router.budgetState();

    expect(spent.calls).toBe(1);
    expect(spent.tokensUsed).toBeGreaterThan(0);
    await prepared.finish();
  });
});

describe('a run prepared for a session that has nothing attached', () => {
  it('describes nothing and spends nothing', async () => {
    const held = await workshopFor([]);

    const prepared = await held.workshop.prepare(held.session, {
      signal: new AbortController().signal,
    });

    expect(held.vision.calls).toHaveLength(0);
    expect(prepared.input.router.budgetState().calls).toBe(0);
    await prepared.finish();
  });

  it('still prepares when no attachment storage is configured at all', async () => {
    const held = await workshopFor([attachment()], { wired: false });

    const prepared = await held.workshop.prepare(held.session, {
      signal: new AbortController().signal,
    });

    expect(prepared.installationId).toBe(4_242);
    expect(prepared.input.images).toEqual([]);
    await prepared.finish();
  });
});

describe('the immutable repository base', () => {
  async function recoveryHarness(options: {
    resolve: BaseCommitResolver['resolve'];
    beforeRent?: () => void;
  }): Promise<{
    session: SessionDocument;
    records: InMemorySessionRecords;
    workshop: LiveSessionWorkshop;
    sandboxes: FakeSandboxProvider;
  }> {
    const session = sessionDocument({ baseCommitSha: null });
    const records = new InMemorySessionRecords();
    await records.insert(session);
    const sandboxes = new FakeSandboxProvider({ files: {} });
    const provider: SandboxProvider = {
      name: sandboxes.name,
      real: sandboxes.real,
      create: async (spec) => {
        options.beforeRent?.();
        return await sandboxes.create(spec);
      },
    };

    return {
      session,
      records,
      sandboxes,
      workshop: new LiveSessionWorkshop({
        db: NO_DATABASE,
        installations: {
          activeInstallation: async () => Promise.resolve({ installationId: 4_242 }),
        },
        tokens: new FakeGitHubTokenProvider(),
        sandboxes: provider,
        text: fixedText(new FakeTextProvider({ answers: [] })),
        providerKeys: everyProviderKey(),
        config: loadConfig(minimalEnv()),
        logger: capturingLogger().logger,
        records,
        baseCommits: { resolve: options.resolve },
      }),
    };
  }

  it('persists the resolved SHA before it rents a sandbox', async () => {
    let records: InMemorySessionRecords | null = null;
    const held = await recoveryHarness({
      resolve: async () => Promise.resolve(ORIGINAL_SHA),
      beforeRent: () => {
        expect(records?.documents[0]?.baseCommitSha).toBe(ORIGINAL_SHA);
      },
    });
    records = held.records;

    const prepared = await held.workshop.prepare(held.session, {
      signal: new AbortController().signal,
    });

    expect(prepared.input.reference.commitSha).toBe(ORIGINAL_SHA);
    await prepared.finish();
  });

  it('keeps using the first SHA after the default branch advances between attempts', async () => {
    let head = ORIGINAL_SHA;
    let resolutions = 0;
    const held = await recoveryHarness({
      resolve: async () => {
        resolutions += 1;
        return Promise.resolve(head);
      },
    });

    const first = await held.workshop.prepare(held.session, {
      signal: new AbortController().signal,
    });
    await first.finish();
    head = MOVED_SHA;

    const recovered = await held.records.findById(held.session.sessionId);
    expect(recovered?.baseCommitSha).toBe(ORIGINAL_SHA);
    if (recovered === null) {
      throw new Error('expected the session to remain available for recovery');
    }

    const second = await held.workshop.prepare(recovered, {
      signal: new AbortController().signal,
    });

    expect(second.input.reference.commitSha).toBe(ORIGINAL_SHA);
    expect(resolutions).toBe(1);
    await second.finish();
  });

  it('lets one concurrent attempt pin the base and makes every attempt use it', async () => {
    let next = 0;
    const held = await recoveryHarness({
      resolve: async () => Promise.resolve(next++ === 0 ? ORIGINAL_SHA : MOVED_SHA),
    });

    const [first, second] = await Promise.all([
      held.workshop.prepare({ ...held.session }, { signal: new AbortController().signal }),
      held.workshop.prepare({ ...held.session }, { signal: new AbortController().signal }),
    ]);

    expect(first.input.reference.commitSha).toBe(ORIGINAL_SHA);
    expect(second.input.reference.commitSha).toBe(ORIGINAL_SHA);
    expect(held.records.documents[0]?.baseCommitSha).toBe(ORIGINAL_SHA);
    await Promise.all([first.finish(), second.finish()]);
  });

  it('does not write a SHA or rent a sandbox after cancellation wins the race', async () => {
    let cancel = async (): Promise<void> => Promise.resolve();
    const held = await recoveryHarness({
      resolve: async () => {
        await cancel();
        return ORIGINAL_SHA;
      },
    });
    cancel = async () => {
      await held.records.finish(
        held.session.userId,
        held.session.sessionId,
        'cancelled',
        new Date(),
      );
    };

    await expect(
      held.workshop.prepare(held.session, { signal: new AbortController().signal }),
    ).rejects.toThrow(expect.objectContaining({ reason: 'stopped' }) as Error);
    expect(held.records.documents[0]?.baseCommitSha).toBeNull();
    expect(held.sandboxes.specs).toHaveLength(0);
  });
});

describe('the model a run is prepared with', () => {
  const planOf = async (model: SessionDocument['model']): Promise<ModelPlan> => {
    const held = await workshopFor([]);
    const prepared = await held.workshop.prepare(
      { ...held.session, model },
      { signal: new AbortController().signal },
    );

    const plan = prepared.input.state.models;
    await prepared.finish();
    return plan;
  };

  it('uses the default when nobody chose one', async () => {
    const plan = await planOf(null);

    expect(plan.primary).toBe(DEFAULT_TEXT_MODEL);
    expect(plan.chosenByUser).toBe(false);
  });

  it('uses the default for a session written before the field existed', async () => {
    const plan = await planOf(undefined as unknown as SessionDocument['model']);

    expect(plan.primary).toBe(DEFAULT_TEXT_MODEL);
  });

  for (const model of SELECTABLE_TEXT_MODELS) {
    it(`puts ${model} in the primary role when it was chosen, and reaches its own provider`, async () => {
      const plan = await planOf({ textModel: model });

      expect(plan.primary).toBe(model);
      expect(plan.chosenByUser).toBe(true);
      expect(findModel(plan.primary)?.provider).toBe(findModel(model)?.provider);
    });
  }

  it('puts the chosen model in the primary role rather than the default', async () => {
    const plan = await planOf({ textModel: 'gemini-3.5-flash-lite' });

    expect(plan.primary).toBe('gemini-3.5-flash-lite');
    expect(findModel(plan.primary)?.provider).toBe('gemini');
  });

  it('leaves the server owned roles alone whatever was chosen', async () => {
    const chosen = await planOf({ textModel: 'gemini-3.5-flash-lite' });
    const untouched = await planOf(null);

    expect(chosen.light).toBe(untouched.light);
    expect(chosen.reasoning).toBe(untouched.reasoning);
    expect(chosen.vision).toBe(untouched.vision);
  });

  it('fails the run rather than swapping in another model when the choice is gone', async () => {
    const held = await workshopFor([]);

    await expect(
      held.workshop.prepare(
        { ...held.session, model: { textModel: 'a-model-that-was-removed' } },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'models' }) as Error);
  });
});

describe('the limits a run is prepared with', () => {
  it('takes the sandbox caps from configuration rather than from a global', async () => {
    const held = await workshopFor([], {
      env: { MAX_TOOL_OUTPUT_BYTES: '4096', MAX_CHANGED_FILES: '3', MAX_DIFF_LINES: '40' },
    });

    const prepared = await held.workshop.prepare(held.session, {
      signal: new AbortController().signal,
    });

    expect(prepared.input.limits).toEqual({
      maxAttachmentBytes: DEFAULT_LIMITS.maxAttachmentBytes,
      maxToolOutputBytes: 4096,
      maxAgentSteps: DEFAULT_LIMITS.maxAgentSteps,
      maxChangedFiles: 3,
      maxDiffLines: 40,
      maxSandboxSeconds: DEFAULT_LIMITS.maxSandboxSeconds,
    });

    await prepared.finish();
  });

  it('keeps the step budget the session was written with, whatever configuration says now', async () => {
    const held = await workshopFor([], { env: { MAX_AGENT_STEPS: '9' } });

    const prepared = await held.workshop.prepare(
      { ...held.session, maxSteps: 12 },
      { signal: new AbortController().signal },
    );

    expect(prepared.input.state.budgets.maxSteps).toBe(12);
    await prepared.finish();
  });

  it('falls back to the configured budget when the session carries none', async () => {
    const held = await workshopFor([], { env: { MAX_AGENT_STEPS: '9' } });

    const prepared = await held.workshop.prepare(
      { ...held.session, maxSteps: 0 },
      { signal: new AbortController().signal },
    );

    expect(prepared.input.state.budgets.maxSteps).toBe(9);
    await prepared.finish();
  });

  it('hands the sandbox the same numbers it hands the trusted validator', async () => {
    const held = await workshopFor([], { env: { MAX_CHANGED_FILES: '3', MAX_DIFF_LINES: '40' } });
    const sandboxes = new FakeSandboxProvider({ files: {} });

    const prepared = await new LiveSessionWorkshop({
      db: NO_DATABASE,
      installations: { activeInstallation: async () => Promise.resolve({ installationId: 4_242 }) },
      tokens: new FakeGitHubTokenProvider(),
      sandboxes,
      text: fixedText(new FakeTextProvider({ answers: [] })),
      providerKeys: everyProviderKey(),
      config: loadConfig({ ...minimalEnv(), MAX_CHANGED_FILES: '3', MAX_DIFF_LINES: '40' }),
      logger: capturingLogger().logger,
    }).prepare(held.session, { signal: new AbortController().signal });

    const spec = sandboxes.specs[0];

    expect(spec?.maxChangedFiles).toBe(3);
    expect(spec?.maxDiffLines).toBe(40);
    expect(prepared.input.limits?.maxChangedFiles).toBe(spec?.maxChangedFiles);
    expect(prepared.input.limits?.maxDiffLines).toBe(spec?.maxDiffLines);

    await prepared.finish();
  });
});
