import {
  OtpRequestResponseSchema,
  OtpVerifyResponseSchema,
  type SessionContext,
} from '@nimbus/contracts';
import { useEffect, useReducer, useRef, useState, type SyntheticEvent } from 'react';

import type { ApiClient } from '../api/client.js';
import { API_BASE_URL } from '../config.js';
import {
  CODE_DIGITS,
  FIRST_STATE,
  codeIsComplete,
  countdownWords,
  emailProblem,
  needsFreshCode,
  onlyDigits,
  problemFor,
  reduceSignIn,
  secondsLeft,
} from '../auth/signin.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';

export interface SignInProps {
  api: ApiClient;
  onSignedIn: (context: SessionContext) => void;
  googleAvailable?: boolean;
  initialProblem?: string | null;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);

    return (): void => {
      clearInterval(timer);
    };
  }, [active]);

  return now;
}

export function SignIn({
  api,
  onSignedIn,
  googleAvailable = true,
  initialProblem = null,
}: SignInProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reduceSignIn, {
    ...FIRST_STATE,
    problem: initialProblem,
  });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);

  const onCodeStep = state.step.name === 'code';
  const now = useNow(onCodeStep);

  useEffect(() => {
    if (onCodeStep) {
      codeInput.current?.focus();
    }
  }, [onCodeStep]);

  const sendCode = async (address: string, resent: boolean): Promise<void> => {
    dispatch({ type: 'sending' });

    try {
      const sent = await api.post(
        '/auth/otp/request',
        { email: address },
        OtpRequestResponseSchema,
      );
      setCode('');
      dispatch({ type: 'code_sent', email: address, sent, now: Date.now(), resent });
    } catch (error) {
      dispatch({ type: 'failed', problem: problemFor(error), startOver: false });
    }
  };

  const onEmailSubmit = (event: SyntheticEvent): void => {
    event.preventDefault();
    setEmailTouched(true);

    if (emailProblem(email) !== null) {
      return;
    }
    void sendCode(email.trim(), false);
  };

  const onCodeSubmit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();

    if (state.step.name !== 'code' || !codeIsComplete(code)) {
      return;
    }

    dispatch({ type: 'verifying' });

    try {
      const context = await api.post(
        '/auth/otp/verify',
        { requestId: state.step.requestId, email: state.step.email, code },
        OtpVerifyResponseSchema,
      );
      onSignedIn(context);
    } catch (error) {
      if (needsFreshCode(error)) {
        setCode('');
      }
      dispatch({ type: 'failed', problem: problemFor(error), startOver: false });
      codeInput.current?.focus();
    }
  };

  const shownEmailProblem = emailTouched ? emailProblem(email) : null;

  return (
    <div className="container">
      <section className="signin">
        <div className="signin__card">
          <header className="signin__head">
            <p className="signin__eyebrow">
              {state.step.name === 'email' ? 'Sign in' : 'Step 2 of 2'}
            </p>

            {state.step.name === 'email' ? (
              <>
                <h1 className="signin__title">Sign in to Nimbus</h1>
                <p className="signin__sub">
                  We send a {String(CODE_DIGITS)} digit code. No password to remember or lose.
                </p>
              </>
            ) : (
              <>
                <h1 className="signin__title">Enter your code</h1>
                <p className="signin__sub">
                  Sent to <strong>{state.step.email}</strong>. It expires in{' '}
                  {countdownWords(secondsLeft(state.step.expiresAt, now))}.
                </p>
              </>
            )}
          </header>

          {state.problem === null ? null : (
            <p className="note note--problem" role="alert">
              <span className="note__mark" aria-hidden="true" />
              {state.problem}
            </p>
          )}

          {state.problem === null && state.notice !== null ? (
            <p className="note" role="status">
              <span className="note__mark" aria-hidden="true" />
              {state.notice}
            </p>
          ) : null}

          {state.step.name === 'email' ? (
            <form className="signin__form" onSubmit={onEmailSubmit} noValidate>
              <Field
                label="Email address"
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                autoFocus
                required
                placeholder="you@example.com"
                value={email}
                problem={shownEmailProblem}
                disabled={state.busy === 'sending'}
                onBlur={(): void => {
                  setEmailTouched(true);
                }}
                onChange={(event): void => {
                  setEmail(event.target.value);
                }}
              />

              <Button type="submit" tone="primary" block large disabled={state.busy === 'sending'}>
                {state.busy === 'sending' ? 'Sending a code' : 'Send me a code'}
              </Button>

              {googleAvailable ? (
                <>
                  <p className="divider">or</p>

                  <a
                    className="button button--secondary button--block button--large"
                    href={`${API_BASE_URL}/auth/google`}
                  >
                    <span className="google">Continue with Google</span>
                  </a>
                </>
              ) : null}
            </form>
          ) : (
            <form
              className="signin__form"
              onSubmit={(event): void => {
                void onCodeSubmit(event);
              }}
              noValidate
            >
              <Field
                ref={codeInput}
                label={`${String(CODE_DIGITS)} digit code`}
                code
                name="one-time-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={CODE_DIGITS}
                required
                placeholder={'0'.repeat(CODE_DIGITS)}
                value={code}
                hint="Paste it or type it. Nothing is submitted until you press continue."
                disabled={state.busy === 'verifying'}
                onChange={(event): void => {
                  setCode(onlyDigits(event.target.value));
                }}
              />

              <Button
                type="submit"
                tone="primary"
                block
                large
                disabled={state.busy === 'verifying' || !codeIsComplete(code)}
              >
                {state.busy === 'verifying' ? 'Checking' : 'Continue'}
              </Button>

              <div className="signin__row">
                <Button
                  tone="quiet"
                  onClick={(): void => {
                    dispatch({ type: 'back_to_email' });
                    setCode('');
                  }}
                >
                  Use a different email
                </Button>

                {secondsLeft(state.step.resendAt, now) > 0 ? (
                  <span className="signin__timer">
                    Resend in {countdownWords(secondsLeft(state.step.resendAt, now))}
                  </span>
                ) : (
                  <Button
                    tone="quiet"
                    disabled={state.busy === 'sending'}
                    onClick={(): void => {
                      if (state.step.name === 'code') {
                        void sendCode(state.step.email, true);
                      }
                    }}
                  >
                    {state.busy === 'sending' ? 'Sending' : 'Send a new code'}
                  </Button>
                )}
              </div>
            </form>
          )}

          <p className="signin__foot">
            Nimbus only ever opens pull requests for you to review. It never merges anything.
          </p>
        </div>
      </section>
    </div>
  );
}
