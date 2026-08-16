import { EmailSchema, LIMITS, OtpCodeSchema, type ErrorCode } from '@nimbus/contracts';

import { ApiError, NetworkError } from '../api/errors.js';

export const CODE_DIGITS = LIMITS.otpDigits;

export interface CodeStep {
  email: string;
  requestId: string;
  expiresAt: number;
  resendAt: number;
}

export type SignInStep = { name: 'email' } | ({ name: 'code' } & CodeStep);

export type SignInBusy = 'none' | 'sending' | 'verifying';

export interface SignInState {
  step: SignInStep;
  busy: SignInBusy;
  notice: string | null;
  problem: string | null;
}

export const FIRST_STATE: SignInState = {
  step: { name: 'email' },
  busy: 'none',
  notice: null,
  problem: null,
};

const PROBLEMS: Partial<Record<ErrorCode, string>> = {
  OTP_INVALID: 'That code is not right. Check it and try again.',
  OTP_EXPIRED: 'That code has expired. Ask for a new one.',
  OTP_ATTEMPTS_EXCEEDED: 'Too many tries. Ask for a new code.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  VALIDATION_FAILED: 'Check what you entered and try again.',
  ACCOUNT_DISABLED: 'That account cannot sign in.',
  CSRF_TOKEN_INVALID: 'That took too long. Start again.',
  SESSION_EXPIRED: 'That took too long. Start again.',
};

export const GENERIC_PROBLEM = 'Something went wrong. Try again.';

export const UNREACHABLE_PROBLEM = 'Nimbus is not answering. Check your connection and try again.';

export function problemFor(error: unknown): string {
  if (error instanceof NetworkError) {
    return UNREACHABLE_PROBLEM;
  }

  if (error instanceof ApiError) {
    return PROBLEMS[error.code] ?? GENERIC_PROBLEM;
  }
  return GENERIC_PROBLEM;
}

export function needsFreshCode(error: unknown): boolean {
  return error instanceof ApiError && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(error.code);
}

export function emailProblem(candidate: string): string | null {
  const parsed = EmailSchema.safeParse(candidate.trim());
  return parsed.success ? null : 'Enter a valid email address.';
}

export function onlyDigits(candidate: string): string {
  return candidate.replace(/\D/g, '').slice(0, CODE_DIGITS);
}

export function codeIsComplete(candidate: string): boolean {
  return OtpCodeSchema.safeParse(candidate).success;
}

export function secondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1_000));
}

export function countdownWords(seconds: number): string {
  if (seconds <= 0) {
    return 'now';
  }

  if (seconds < 60) {
    return `${String(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`;
}

export interface CodeSent {
  requestId: string;
  expiresInSeconds: number;
  resendAvailableInSeconds: number;
}

export function codeStepFrom(email: string, sent: CodeSent, now: number): CodeStep {
  return {
    email,
    requestId: sent.requestId,
    expiresAt: now + sent.expiresInSeconds * 1_000,
    resendAt: now + sent.resendAvailableInSeconds * 1_000,
  };
}

export type SignInAction =
  | { type: 'sending' }
  | { type: 'verifying' }
  | { type: 'code_sent'; email: string; sent: CodeSent; now: number; resent: boolean }
  | { type: 'failed'; problem: string; startOver: boolean }
  | { type: 'back_to_email' };

export function reduceSignIn(state: SignInState, action: SignInAction): SignInState {
  switch (action.type) {
    case 'sending':
      return { ...state, busy: 'sending', problem: null, notice: null };

    case 'verifying':
      return { ...state, busy: 'verifying', problem: null };

    case 'code_sent':
      return {
        step: { name: 'code', ...codeStepFrom(action.email, action.sent, action.now) },
        busy: 'none',
        problem: null,
        notice: action.resent
          ? 'A new code is on its way.'
          : `If that address has an account, a ${String(CODE_DIGITS)} digit code is on its way.`,
      };

    case 'failed':
      return {
        step: action.startOver ? { name: 'email' } : state.step,
        busy: 'none',
        notice: null,
        problem: action.problem,
      };

    case 'back_to_email':
      return { ...FIRST_STATE };
  }
}
