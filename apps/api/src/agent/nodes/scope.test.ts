import { describe, expect, it } from 'vitest';

import { CLEAR_TASK, SLIPPERY_TASK, TINY_TASK, VAGUE_TASK, nodeHarness } from './nodes.fixtures.js';
import { NODE_LIMITS } from './limits.js';
import { meaningfulWords, tooThinToJudge, validateScope } from './scope.js';

const CLEAR = { value: { clear: true, question: '' } };
const UNCLEAR = {
  value: {
    clear: false,
    question:
      'Which page should people land on after signing in, the dashboard or where they were?',
  },
};

describe('meaningfulWords', () => {
  it('drops the words that carry no meaning', () => {
    expect(meaningfulWords('please fix the thing')).toEqual([]);
  });

  it('keeps the words that do', () => {
    expect(meaningfulWords('the login redirect is broken')).toEqual([
      'login',
      'redirect',
      'is',
      'broken',
    ]);
  });

  it('ignores punctuation and capitals', () => {
    expect(meaningfulWords('Login, Redirect!')).toEqual(['login', 'redirect']);
  });
});

describe('tooThinToJudge', () => {
  it('catches a task that is barely there', () => {
    expect(tooThinToJudge(TINY_TASK)).toContain('too short');
  });

  it('catches a long task made entirely of filler', () => {
    expect(tooThinToJudge('please make the code better and improve everything')).toContain(
      'does not name anything specific',
    );
  });

  it('lets a real task through to be judged properly', () => {
    expect(tooThinToJudge(CLEAR_TASK)).toBeNull();
  });

  it('needs enough real words, not just enough characters', () => {
    const padded = 'the the the the the the the the the the the the';

    expect(padded.length).toBeGreaterThan(NODE_LIMITS.taskMinChars);
    expect(tooThinToJudge(padded)).not.toBeNull();
  });
});

describe('validateScope', () => {
  it('spends no money on a task that is obviously too thin', async () => {
    const harness = await nodeHarness({ task: TINY_TASK });
    const result = await validateScope(harness.state, { router: harness.router });

    expect(result.outcome).toBe('needs_clarification');
    expect(result.askedModel).toBe(false);
    expect(harness.text.callCount).toBe(0);
  });

  it('lets a clear task through without asking anything', async () => {
    const harness = await nodeHarness({ task: CLEAR_TASK, answers: { answers: [CLEAR] } });
    const result = await validateScope(harness.state, { router: harness.router });

    expect(result.outcome).toBe('clear');
    expect(result.question).toBeNull();
    expect(result.askedModel).toBe(true);
  });

  it('asks the question the model wrote about a task that reads real but is not', async () => {
    const harness = await nodeHarness({ task: SLIPPERY_TASK, answers: { answers: [UNCLEAR] } });
    const result = await validateScope(harness.state, { router: harness.router });

    expect(result.outcome).toBe('needs_clarification');
    expect(result.question).toBe(UNCLEAR.value.question);
    expect(result.askedModel).toBe(true);
  });

  it('asks a generic question when it never needed a model to tell', async () => {
    const harness = await nodeHarness({ task: VAGUE_TASK, answers: { answers: [UNCLEAR] } });
    const result = await validateScope(harness.state, { router: harness.router });

    expect(result.outcome).toBe('needs_clarification');
    expect(result.askedModel).toBe(false);
    expect(harness.text.callCount).toBe(0);
  });

  it('uses the light model, not the one doing the real thinking', async () => {
    const harness = await nodeHarness({ answers: { answers: [CLEAR] } });
    await validateScope(harness.state, { router: harness.router });

    expect(harness.text.calls[0]?.model).toBe(harness.router.modelFor('light'));
    expect(harness.text.calls[0]?.model).not.toBe(harness.router.modelFor('primary'));
  });

  it('never asks twice, whatever it thinks of the answer', async () => {
    const harness = await nodeHarness({
      task: VAGUE_TASK,
      clarificationQuestion: 'Which part of the codebase did you mean?',
      clarificationAnswer: 'not sure really',
      answers: { answers: [UNCLEAR] },
    });

    const result = await validateScope(harness.state, { router: harness.router });

    expect(result.outcome).toBe('already_asked');
    expect(result.question).toBeNull();
    expect(harness.text.callCount).toBe(0);
  });

  it('goes ahead once a question was asked, even with no answer yet', async () => {
    const harness = await nodeHarness({
      task: VAGUE_TASK,
      clarificationQuestion: 'Which part did you mean?',
      answers: { answers: [UNCLEAR] },
    });

    expect((await validateScope(harness.state, { router: harness.router })).outcome).toBe(
      'already_asked',
    );
  });

  it('treats an empty question from the model as clear enough', async () => {
    const harness = await nodeHarness({
      answers: { answers: [{ value: { clear: false, question: '   ' } }] },
    });

    expect((await validateScope(harness.state, { router: harness.router })).outcome).toBe('clear');
  });

  it('always says why, so a user can be told', async () => {
    const thin = await nodeHarness({ task: TINY_TASK });
    const clear = await nodeHarness({ answers: { answers: [CLEAR] } });

    expect(
      (await validateScope(thin.state, { router: thin.router })).reason.length,
    ).toBeGreaterThan(0);
    expect(
      (await validateScope(clear.state, { router: clear.router })).reason.length,
    ).toBeGreaterThan(0);
  });

  it('judges the user words and never the repository', async () => {
    const harness = await nodeHarness({ answers: { answers: [CLEAR] } });
    await validateScope(harness.state, { router: harness.router });

    const sent = harness.text.calls[0]?.messages.map((one) => one.content).join('\n') ?? '';

    expect(sent).toContain(CLEAR_TASK);
    expect(sent).not.toContain('redirectAfterLogin');
  });
});
