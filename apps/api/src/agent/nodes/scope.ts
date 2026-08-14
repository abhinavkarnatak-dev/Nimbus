import {
  ScopeResultSchema,
  ScopeVerdictSchema,
  type AgentState,
  type ScopeResult,
  type ScopeVerdict,
} from '@nimbus/contracts';

import type { SessionRouter } from '../../routing/router.js';
import { FILLER_WORDS, NODE_LIMITS } from './limits.js';

export const SCOPE_SYSTEM = [
  'You judge whether a coding request is specific enough for an engineer to start work on,',
  'in a repository they can read but you cannot.',
  'It is specific enough when it names what is wrong or what should change, even loosely,',
  'so that someone could go and look for the relevant code.',
  'It is not specific enough when it could mean almost any change to almost any file.',
  'Assume the engineer is competent and will read the code themselves, so do not ask for detail',
  'they could find on their own, and do not ask for permission or preferences.',
  'If it is not specific enough, give exactly one question that would make it actionable,',
  'naming the choice or the area involved, answerable in one sentence.',
  'Leave the question empty when it is specific enough.',
].join(' ');

export const SCOPE_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    clear: { type: 'boolean', description: 'true when an engineer could start work on it' },
    question: {
      type: 'string',
      description: 'the single question to ask, or an empty string when clear is true',
    },
  },
  required: ['clear', 'question'],
  additionalProperties: false,
};

export function meaningfulWords(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '' && !FILLER_WORDS.has(word));
}

export function tooThinToJudge(task: string): string | null {
  const trimmed = task.trim();

  if (trimmed.length < NODE_LIMITS.taskMinChars) {
    return 'that task is too short to act on';
  }

  if (meaningfulWords(trimmed).length < NODE_LIMITS.taskMinWords) {
    return 'that task does not name anything specific';
  }
  return null;
}

export interface ScopeOptions {
  router: SessionRouter;
}

export async function validateScope(
  state: AgentState,
  options: ScopeOptions,
): Promise<ScopeResult> {
  if (state.clarificationQuestion !== null) {
    return ScopeResultSchema.parse({
      outcome: 'already_asked',
      question: null,
      reason: 'a question has already been asked, so the work goes ahead with what is known',
      askedModel: false,
    });
  }

  const thin = tooThinToJudge(state.task);

  if (thin !== null) {
    return ScopeResultSchema.parse({
      outcome: 'needs_clarification',
      question: 'What would you like changed, and roughly where in the repository does it live?',
      reason: thin,
      askedModel: false,
    });
  }

  const verdict = await judge(state.task, options.router);

  if (verdict.clear || verdict.question.trim() === '') {
    return ScopeResultSchema.parse({
      outcome: 'clear',
      question: null,
      reason: 'the task names something specific enough to start on',
      askedModel: true,
    });
  }

  return ScopeResultSchema.parse({
    outcome: 'needs_clarification',
    question: verdict.question.trim(),
    reason: 'the task could mean too many different changes',
    askedModel: true,
  });
}

async function judge(task: string, router: SessionRouter): Promise<ScopeVerdict> {
  const result = await router.completeStructured({
    role: 'light',
    schema: ScopeVerdictSchema,
    schemaName: 'scope_verdict',
    jsonSchema: SCOPE_JSON_SCHEMA,
    maxOutputTokens: NODE_LIMITS.scopeMaxOutputTokens,
    messages: [
      { role: 'system', content: SCOPE_SYSTEM },
      { role: 'user', content: `The request is:\n\n${task}` },
    ],
  });

  return result.value;
}
