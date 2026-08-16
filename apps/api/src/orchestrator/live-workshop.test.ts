import type { ModelPlan } from '@nimbus/contracts';
import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { InMemoryAttachmentRecords } from '../attachments/repository.js';
import { minimalEnv } from '../config/env.fixtures.js';
import { loadConfig } from '../config/load.js';
import type { AttachmentDocument } from '../db/models/attachment.js';
import type { SessionDocument } from '../db/models/session.js';
import { FakeGitHubTokenProvider } from '../github/fake-token-provider.js';
import { FakeTextProvider } from '../llm/fake-text.js';
import { FakeVisionProvider } from '../llm/fake-vision.js';
import { capturingLogger } from '../llm/llm.fixtures.js';
import { DEFAULT_TEXT_MODEL, findModel } from '../llm/models.js';
import { SessionAttachments } from '../routing/attached.js';
import { ImageDescriber } from '../routing/describe.js';
import { FakeImageBytes, attachment, textAttachment } from '../routing/routing.fixtures.js';
import { SELECTABLE_TEXT_MODELS } from '../routing/selection.js';
import { FakeSandboxProvider } from '../sandbox/fake-provider.js';
import { LiveSessionWorkshop } from './live-workshop.js';
import { sessionDocument } from './orchestrator.fixtures.js';

const NO_DATABASE = {} as unknown as Db;

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
  options: { vision?: FakeVisionProvider; wired?: boolean } = {},
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
    describer: new ImageDescriber({ vision, records, bytes, logger: captured.logger }),
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
      text: new FakeTextProvider({ answers: [] }),
      config: loadConfig(minimalEnv()),
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

  it('does not leave the primary role on Gemini when Groq was chosen', async () => {
    const plan = await planOf({ textModel: 'openai/gpt-oss-120b' });

    expect(findModel(plan.primary)?.provider).toBe('groq');
  });

  it('does not leave the primary role on Groq when Gemini was chosen', async () => {
    const plan = await planOf({ textModel: 'gemini-3.5-flash-lite' });

    expect(findModel(plan.primary)?.provider).toBe('gemini');
  });

  it('leaves the server owned roles alone whatever was chosen', async () => {
    const chosen = await planOf({ textModel: 'openai/gpt-oss-120b' });
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
