import { InMemoryAttachmentRecords } from '../../src/attachments/repository.js';
import type { AttachmentDocument } from '../../src/db/models/attachment.js';
import { FakeTextProvider, FakeVisionProvider } from '../../src/llm/index.js';
import type { LlmError } from '../../src/llm/index.js';
import { createLogger } from '../../src/logging/logger.js';
import { retrieveContext } from '../../src/retrieval/index.js';
import {
  SAMPLE_LINKS,
  SAMPLE_REPOSITORIES,
  SAMPLE_REPOSITORY,
  SAMPLE_TASK,
} from '../../src/retrieval/retrieval.fixtures.js';
import {
  ImageDescriber,
  SELECTABLE_TEXT_MODELS,
  SessionRouter,
  buildContext,
  selectableModels,
} from '../../src/routing/index.js';
import { FakeImageBytes, attachment, textAttachment } from '../../src/routing/routing.fixtures.js';
import { FakeSandboxProvider, buildSandboxSpec } from '../../src/sandbox/index.js';

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(28)} ${String(value)}\n`);
}

function money(microCents: number): string {
  return `${(microCents / 100_000).toFixed(4)} cents`;
}

async function repositoryContext(): Promise<string> {
  const provider = new FakeSandboxProvider({
    files: SAMPLE_REPOSITORY,
    links: SAMPLE_LINKS,
    repositories: SAMPLE_REPOSITORIES,
  });

  const sandbox = await provider.create(
    buildSandboxSpec(
      { provider: 'fake', maxSeconds: 60, allowInternet: false, templateId: 'demo' },
      'ses_demodemodemodemodem',
    ),
  );

  const bundle = await retrieveContext(sandbox, { task: SAMPLE_TASK, maxFiles: 3 });
  await sandbox.terminate('completed');
  return bundle.text;
}

async function main(): Promise<void> {
  const logger = createLogger({ level: 'warn', environment: 'development' });

  heading('Models a user may choose');
  for (const model of selectableModels()) {
    line(model.id, `${model.provider}${model.vision ? ', can see images' : ''}`);
  }

  heading('A model they may not choose');
  try {
    new SessionRouter({
      text: new FakeTextProvider(),
      logger,
      selection: { textModel: 'gpt-9-ultra' },
    });
    line('result', 'it was accepted, which it should not have been');
  } catch (error) {
    line('code', (error as LlmError).code);
    line('substituted', 'nothing, the session simply does not start');
  }

  heading('The plan for one session');
  const text = new FakeTextProvider({
    answers: [
      {
        text: 'The redirect ignores returnTo.',
        usage: { promptTokens: 900, completionTokens: 40 },
      },
    ],
  });
  const router = new SessionRouter({
    text,
    logger,
    selection: { textModel: SELECTABLE_TEXT_MODELS[2] ?? 'openai/gpt-oss-120b' },
  });
  line('primary, user chose it', router.modelFor('primary'));
  line('light, Nimbus chose it', router.modelFor('light'));
  line('reasoning, Nimbus chose', router.modelFor('reasoning'));
  line('vision, Nimbus chose it', router.modelFor('vision'));

  heading('A session with no images');
  const quiet = new FakeVisionProvider();
  const quietDescriber = new ImageDescriber({
    vision: quiet,
    records: new InMemoryAttachmentRecords(),
    bytes: new FakeImageBytes(),
    logger,
  });
  await quietDescriber.describeAll([textAttachment(), textAttachment()]);
  line('vision calls', quiet.calls.length);
  line('what that saves', 'about 1 cent per image that was never sent');

  heading('A session with two images');
  const vision = new FakeVisionProvider({
    descriptions: [
      { description: 'A red error box reading TypeError: undefined at src/auth/login.ts:42.' },
      { description: 'A browser address bar showing /dashboard after signing in.' },
    ],
  });
  const records = new InMemoryAttachmentRecords();
  const images: AttachmentDocument[] = [attachment(), attachment()];

  for (const image of images) {
    await records.insert(image);
  }

  const describer = new ImageDescriber({ vision, records, bytes: new FakeImageBytes(), logger });
  const first = await describer.describeAll(images);

  line('vision calls', vision.calls.length);
  line('descriptions', first.images.length);
  for (const report of first.reports) {
    router.charge(report);
  }
  line('charged', money(router.budgetState().microCentsUsed));

  heading('The same two images again');
  const stored = await Promise.all(
    images.map(async (image) => await records.findOwned(image.userId, image.attachmentId)),
  );
  const again = await describer.describeAll(stored.filter((one) => one !== null));

  line('vision calls, total', vision.calls.length);
  line('descriptions', again.images.length);
  line('reused', again.images.filter((image) => image.reused).length);
  line('charged for them', money(0));

  heading('What the model is actually given');
  const retrieval = await repositoryContext();
  const context = buildContext({
    task: SAMPLE_TASK,
    images: again.images,
    attachments: [
      { name: 'build.log', contents: 'error TS2339: Property returnTo does not exist' },
    ],
    retrieval,
  });

  line('parts kept', context.summary.parts.join(', '));
  line('parts dropped', context.summary.dropped.join(', ') || 'none');
  line('characters', context.summary.characters);
  process.stdout.write(`\n${context.text.slice(0, 900)}\n...\n`);

  heading('Squeezed into a small budget');
  const tight = buildContext({
    task: SAMPLE_TASK,
    images: again.images,
    attachments: [{ name: 'build.log', contents: 'y'.repeat(5_000) }],
    retrieval,
    maxChars: 900,
  });
  line('parts kept', tight.summary.parts.join(', '));
  line('parts dropped', tight.summary.dropped.join(', '));
  line('the task survived', tight.text.includes(SAMPLE_TASK));

  heading('Asking the model, and paying for it');
  const answer = await router.complete({
    messages: [
      { role: 'system', content: 'You fix small bugs.' },
      { role: 'user', content: context.text },
    ],
  });
  line('model used', answer.report.model);
  line('answer', answer.text);

  const state = router.budgetState();
  line('calls', `${String(state.calls)} of ${String(state.callLimit)}`);
  line('tokens', `${String(state.tokensUsed)} of ${String(state.tokenLimit)}`);
  line('spent', `${money(state.microCentsUsed)}, estimated`);

  heading('When the session runs out');
  const broke = new SessionRouter({
    text: new FakeTextProvider(),
    logger,
    budgetLimits: { callLimit: 1 },
  });
  await broke.complete({ messages: [{ role: 'user', content: 'first' }] });

  try {
    await broke.complete({ messages: [{ role: 'user', content: 'second' }] });
    line('result', 'it answered, which it should not have');
  } catch (error) {
    line('code', (error as LlmError).code);
    line('calls made', broke.budgetState().calls);
    line('stopped before sending', 'yes, so nothing was half done');
  }
}

await main();
