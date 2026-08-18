import { AGENT_STOP_REASONS } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { LlmError } from '../llm/errors.js';
import { FAILURE_MESSAGES, failureForRun, failureForStop, failureOf } from './outcome.js';

describe('what a person is told when a run stops', () => {
  it('says the steps ran out only when the steps ran out', () => {
    expect(failureForStop('step_budget').code).toBe('STEP_BUDGET_EXHAUSTED');
  });

  it('does not call going in circles running out of steps', () => {
    for (const reason of ['repeated_action', 'retry_budget'] as const) {
      const said = failureForStop(reason);

      expect(said.code).toBe('AGENT_STUCK');
      expect(said.message).not.toContain('all of its steps');
    }
  });

  it('keeps the budgets apart from each other', () => {
    expect(failureForStop('token_budget').code).toBe('TOKEN_BUDGET_EXHAUSTED');
    expect(failureForStop('time_budget').code).toBe('TIME_BUDGET_EXHAUSTED');
  });

  it('falls back to an internal error when nothing said why', () => {
    expect(failureForStop(null).code).toBe('INTERNAL_ERROR');
    expect(failureForStop('failed').code).toBe('INTERNAL_ERROR');
  });

  it('has words for every stop reason a run can end with', () => {
    for (const reason of AGENT_STOP_REASONS) {
      expect(failureForStop(reason).message).not.toBe('');
    }
  });

  it('gives every failure code its own sentence', () => {
    const said = Object.values(FAILURE_MESSAGES);

    expect(new Set(said).size).toBe(said.length);
  });

  it('never leaves a code without words', () => {
    expect(failureOf('AGENT_STUCK').message).toBe(FAILURE_MESSAGES.AGENT_STUCK);
  });
});

describe('when the model provider is what went wrong', () => {
  it('says a rate limit was a rate limit', () => {
    const said = failureForRun(
      'failed',
      new LlmError('LLM_RATE_LIMITED', 'refused', { status: 429 }),
    );

    expect(said.code).toBe('MODEL_RATE_LIMITED');
    expect(said.message).not.toBe(FAILURE_MESSAGES.INTERNAL_ERROR);
  });

  it('sends somebody to their key when the key was refused', () => {
    for (const code of ['LLM_UNAUTHENTICATED', 'LLM_NOT_CONFIGURED'] as const) {
      expect(failureForRun('failed', new LlmError(code, 'no')).code).toBe('MODEL_KEY_REJECTED');
    }
  });

  it('tells an outage apart from a key and from a rate limit', () => {
    for (const code of ['LLM_UNAVAILABLE', 'LLM_TIMED_OUT', 'LLM_FAILED'] as const) {
      expect(failureForRun('failed', new LlmError(code, 'no')).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  it('blames the model, not the machine, for an answer it could not shape', () => {
    for (const code of ['LLM_SCHEMA_REFUSED', 'LLM_RESPONSE_MALFORMED', 'LLM_TRUNCATED'] as const) {
      expect(failureForRun('failed', new LlmError(code, 'no')).code).toBe('MODEL_ANSWER_UNUSABLE');
    }
  });

  it('leaves the stop reason alone when nothing was thrown', () => {
    expect(failureForRun('step_budget', undefined).code).toBe('STEP_BUDGET_EXHAUSTED');
    expect(failureForRun('repeated_action', undefined).code).toBe('AGENT_STUCK');
  });

  it('still reports an internal error for something that is not a model problem', () => {
    expect(failureForRun('failed', new TypeError('undefined is not a function')).code).toBe(
      'INTERNAL_ERROR',
    );
  });
});
