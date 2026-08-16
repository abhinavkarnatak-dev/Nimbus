import type { ErrorCode } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError, NetworkError } from '../api/errors.js';
import {
  CODE_DIGITS,
  FIRST_STATE,
  GENERIC_PROBLEM,
  UNREACHABLE_PROBLEM,
  codeIsComplete,
  codeStepFrom,
  countdownWords,
  emailProblem,
  needsFreshCode,
  onlyDigits,
  problemFor,
  reduceSignIn,
  secondsLeft,
  type SignInState,
} from './signin.js';

const NOW = Date.UTC(2026, 7, 17, 10, 0, 0);

const SENT = {
  requestId: `req_${'a'.repeat(21)}`,
  expiresInSeconds: 600,
  resendAvailableInSeconds: 60,
};

function failing(code: ErrorCode): ApiError {
  return new ApiError({ code, message: 'no', status: 400 });
}

function onCodeStep(): SignInState {
  return reduceSignIn(FIRST_STATE, {
    type: 'code_sent',
    email: 'person@example.com',
    sent: SENT,
    now: NOW,
    resent: false,
  });
}

describe('checking an email before asking the server', () => {
  it('accepts a real address', () => {
    expect(emailProblem('person@example.com')).toBeNull();
  });

  it('ignores the spaces somebody pasted around it', () => {
    expect(emailProblem('  person@example.com  ')).toBeNull();
  });

  it('refuses something that is not an address', () => {
    expect(emailProblem('person')).not.toBeNull();
    expect(emailProblem('')).not.toBeNull();
  });
});

describe('the code somebody types', () => {
  it('keeps only digits, because the code is only digits', () => {
    expect(onlyDigits('12-34 56ab78')).toBe('12345678');
  });

  it('never grows past the length of a real code', () => {
    expect(onlyDigits('1'.repeat(40))).toHaveLength(CODE_DIGITS);
  });

  it('is complete only at exactly the right length', () => {
    expect(codeIsComplete('1'.repeat(CODE_DIGITS))).toBe(true);
    expect(codeIsComplete('1'.repeat(CODE_DIGITS - 1))).toBe(false);
    expect(codeIsComplete('')).toBe(false);
  });
});

describe('counting down', () => {
  it('rounds up, so a timer never shows zero while there is time left', () => {
    expect(secondsLeft(NOW + 1_200, NOW)).toBe(2);
  });

  it('never goes below zero', () => {
    expect(secondsLeft(NOW - 10_000, NOW)).toBe(0);
  });

  it('says it in words a person reads at a glance', () => {
    expect(countdownWords(0)).toBe('now');
    expect(countdownWords(45)).toBe('45s');
    expect(countdownWords(60)).toBe('1m');
    expect(countdownWords(605)).toBe('10m 5s');
  });
});

describe('turning what the server said into a deadline', () => {
  it('reads both windows off the same moment', () => {
    const step = codeStepFrom('person@example.com', SENT, NOW);

    expect(secondsLeft(step.expiresAt, NOW)).toBe(600);
    expect(secondsLeft(step.resendAt, NOW)).toBe(60);
  });
});

describe('what a person is told when it fails', () => {
  it('names the four cases they can act on', () => {
    expect(problemFor(failing('OTP_INVALID'))).toContain('not right');
    expect(problemFor(failing('OTP_EXPIRED'))).toContain('expired');
    expect(problemFor(failing('OTP_ATTEMPTS_EXCEEDED'))).toContain('Too many tries');
    expect(problemFor(failing('RATE_LIMITED'))).toContain('Wait a moment');
  });

  it('says something plain for anything else, rather than a code', () => {
    expect(problemFor(failing('INTERNAL_ERROR'))).toBe(GENERIC_PROBLEM);
    expect(problemFor(new Error('boom'))).toBe(GENERIC_PROBLEM);
  });

  it('tells a person the server is unreachable rather than blaming their code', () => {
    expect(problemFor(new NetworkError(new Error('offline')))).toBe(UNREACHABLE_PROBLEM);
  });

  it('never repeats the message the server sent, so nothing leaks through it', () => {
    const chatty = new ApiError({
      code: 'OTP_INVALID',
      message: 'no account for person@example.com',
      status: 400,
    });

    expect(problemFor(chatty)).not.toContain('person@example.com');
  });

  it('knows which failures mean the code in hand is now useless', () => {
    expect(needsFreshCode(failing('OTP_EXPIRED'))).toBe(true);
    expect(needsFreshCode(failing('OTP_ATTEMPTS_EXCEEDED'))).toBe(true);
    expect(needsFreshCode(failing('OTP_INVALID'))).toBe(false);
    expect(needsFreshCode(new NetworkError(new Error('offline')))).toBe(false);
  });
});

describe('moving through sign in', () => {
  it('starts by asking for an email and nothing else', () => {
    expect(FIRST_STATE.step.name).toBe('email');
    expect(FIRST_STATE.problem).toBeNull();
  });

  it('clears an old problem the moment a new attempt starts', () => {
    const failed = reduceSignIn(FIRST_STATE, {
      type: 'failed',
      problem: 'nope',
      startOver: false,
    });

    expect(reduceSignIn(failed, { type: 'sending' }).problem).toBeNull();
  });

  it('moves to the code step and says nothing about whether the account exists', () => {
    const state = onCodeStep();

    expect(state.step.name).toBe('code');
    expect(state.notice).toContain('If that address has an account');
  });

  it('says something different when a code was asked for again', () => {
    const state = reduceSignIn(onCodeStep(), {
      type: 'code_sent',
      email: 'person@example.com',
      sent: SENT,
      now: NOW,
      resent: true,
    });

    expect(state.notice).toBe('A new code is on its way.');
  });

  it('keeps somebody on the code step when their code was simply wrong', () => {
    const state = reduceSignIn(onCodeStep(), {
      type: 'failed',
      problem: 'nope',
      startOver: false,
    });

    expect(state.step.name).toBe('code');
    expect(state.busy).toBe('none');
  });

  it('drops the notice once there is a problem, so only one thing is shown', () => {
    const state = reduceSignIn(onCodeStep(), {
      type: 'failed',
      problem: 'nope',
      startOver: false,
    });

    expect(state.notice).toBeNull();
    expect(state.problem).toBe('nope');
  });

  it('goes back to a clean email step when somebody asks to change it', () => {
    expect(reduceSignIn(onCodeStep(), { type: 'back_to_email' })).toStrictEqual(FIRST_STATE);
  });

  it('never leaves a button spinning after a failure', () => {
    const busy = reduceSignIn(onCodeStep(), { type: 'verifying' });
    const failed = reduceSignIn(busy, { type: 'failed', problem: 'nope', startOver: false });

    expect(busy.busy).toBe('verifying');
    expect(failed.busy).toBe('none');
  });
});
