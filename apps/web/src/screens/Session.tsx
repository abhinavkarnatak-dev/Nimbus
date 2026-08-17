import {
  AnswerSessionBodySchema,
  ApprovalRecordSchema,
  CancelSessionResponseSchema,
  CreateSessionResponseSchema,
  PostMessageResponseSchema,
  type ApprovalDecision,
  type SessionId,
} from '@nimbus/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { ApiClient } from '../api/client.js';
import { ApiError, NetworkError } from '../api/errors.js';
import { ROUTE_PATHS } from '../app/routes.js';
import { plainText, safeHref } from '../render/safe.js';
import { answered, decided } from '../sessions/live.js';
import { isLive, statusWords, toneFor } from '../sessions/status.js';
import type { LiveSessionHandle } from '../sessions/useLiveSession.js';
import { Button } from '../ui/Button.js';
import { Loading, Skeleton } from '../ui/Skeleton.js';

const WIRE_WORDS: Readonly<Record<string, string>> = {
  idle: 'offline',
  connecting: 'connecting',
  live: 'live',
  waiting: 'reconnecting',
  signed_out: 'signed out',
  closed: 'closed',
};

function actProblem(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'Nimbus is not answering. Check your connection and try again.';
  }

  if (!(error instanceof ApiError)) {
    return 'That did not work. Try again.';
  }

  const known: Partial<Record<string, string>> = {
    SESSION_NOT_ACTIVE: 'This session has already finished.',
    APPROVAL_NOT_FOUND: 'That request is no longer waiting for you.',
    APPROVAL_EXPIRED: 'That request expired. The session moved on without it.',
    APPROVAL_MISMATCH: 'That request changed while you were reading it. Reload and look again.',
    CONFLICT: 'That was already answered.',
    VALIDATION_FAILED: 'Check what you entered and try again.',
  };

  return known[error.code] ?? 'That did not work. Try again.';
}

export interface SessionScreenProps {
  api: ApiClient;
  sessionId: SessionId;
  view: LiveSessionHandle;
}

export function Session({ api, sessionId, view }: SessionScreenProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const detail = view.detail;
  const live = view.live;
  const running = live !== null && isLive(live.status);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [live?.messages.length, live?.approval, live?.question]);

  if (view.load === 'missing') {
    return (
      <div className="container">
        <section className="placeholder">
          <p className="placeholder__eyebrow">404</p>
          <h1 className="placeholder__title">No such session</h1>
          <p className="placeholder__body">It may belong to another account, or never existed.</p>
        </section>
      </div>
    );
  }

  if (detail === null || live === null) {
    return (
      <div className="container">
        <section className="placeholder">
          <Loading what="Loading this session.">
            <div className="skeleton-stack">
              <Skeleton shape="pill" width="6rem" />
              <Skeleton shape="title" width="60%" />
              <Skeleton shape="block" height="12rem" />
              <Skeleton shape="block" height="4rem" />
            </div>
          </Loading>
        </section>
      </div>
    );
  }

  const send = async (): Promise<void> => {
    const said = text.trim();

    if (said === '' || busy) {
      return;
    }

    setBusy(true);
    setProblem(null);

    try {
      if (live.question === null) {
        const posted = await api.post(
          `/sessions/${sessionId}/messages`,
          { message: said },
          PostMessageResponseSchema,
        );

        view.change((held) => ({ ...held, messages: [...held.messages, posted.message] }));
      } else {
        AnswerSessionBodySchema.parse({ message: said });

        await api.post(
          `/sessions/${sessionId}/answer`,
          { message: said },
          CreateSessionResponseSchema,
        );

        view.change((held) => answered(held));
        await view.refresh();
      }

      setText('');
    } catch (error) {
      setProblem(actProblem(error));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    const asked = live.approval;

    if (asked === null || busy) {
      return;
    }

    setBusy(true);
    setProblem(null);

    try {
      await api.post(
        `/sessions/${sessionId}/approvals`,
        { approvalId: asked.approvalId, actionHash: asked.actionHash, decision },
        ApprovalRecordSchema,
      );

      view.change((held) => decided(held));
    } catch (error) {
      setProblem(actProblem(error));
      await view.refresh();
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);

    try {
      await api.post(`/sessions/${sessionId}/cancel`, {}, CancelSessionResponseSchema);
      await view.refresh();
    } catch (error) {
      setProblem(actProblem(error));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const prUrl = live.pullRequest === null ? null : safeHref(live.pullRequest.url);

  return (
    <div className="run">
      <header className="run__head">
        <a className="run__back button button--quiet" href={ROUTE_PATHS.dashboard}>
          &larr; Sessions
        </a>

        <div className="run__what">
          <p className="run__task">{plainText(detail.task, 200)}</p>
          <p className="run__where">
            {detail.repository.owner}/{detail.repository.name}
            {live.progress.maxSteps > 0
              ? ` · step ${String(live.progress.step)} of ${String(live.progress.maxSteps)}`
              : ''}
          </p>
        </div>

        <div className="run__tools">
          <span className="status" data-tone={toneFor(live.status)}>
            <span className="status__dot" aria-hidden="true" />
            {statusWords(live.status)}
          </span>

          {running ? (
            <span className="wire" data-state={view.connection} aria-live="polite">
              <span className="wire__dot" aria-hidden="true" />
              {WIRE_WORDS[view.connection] ?? view.connection}
            </span>
          ) : null}

          {prUrl === null ? null : (
            <a className="link" href={prUrl} target="_blank" rel="noreferrer">
              Pull request #{String(live.pullRequest?.number ?? 0)}
            </a>
          )}

          {running ? (
            <Button tone="quiet" disabled={busy} onClick={(): void => void stop()}>
              Cancel
            </Button>
          ) : null}
        </div>
      </header>

      <div className="thread">
        <div className="thread__inner">
          <AnimatePresence initial={false}>
            {live.messages.map((one) => (
              <motion.div
                key={one.messageId}
                className="turn"
                data-role={one.role}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              >
                <span className="turn__who">{one.role === 'agent' ? 'Nimbus' : 'You'}</span>
                <p className="turn__body">{one.text}</p>
              </motion.div>
            ))}

            {live.question === null ? null : (
              <motion.div
                key="question"
                className="card card--ask"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              >
                <p className="card__word">Nimbus is asking</p>
                <p className="card__what">{live.question.question}</p>
                <p className="card__why">
                  Answer below and the run carries on from where it paused.
                </p>
              </motion.div>
            )}

            {live.approval === null ? null : (
              <motion.div
                key={live.approval.approvalId}
                className="card"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              >
                <p className="card__word">Needs your approval</p>
                <p className="card__what">{live.approval.effect.summary}</p>
                <p className="card__why">{live.approval.effect.reason}</p>

                {live.approval.effect.paths.length === 0 ? null : (
                  <div className="card__paths">
                    {live.approval.effect.paths.map((path) => (
                      <span className="card__path" key={path}>
                        {path}
                      </span>
                    ))}
                  </div>
                )}

                <p className="card__meta">
                  <span className="risk" data-risk={live.approval.effect.risk}>
                    {live.approval.effect.risk} risk
                  </span>
                  <span>{live.approval.effect.category.split('_').join(' ')}</span>
                  {live.approval.effect.commandCategory === undefined ? null : (
                    <span>{live.approval.effect.commandCategory}</span>
                  )}
                </p>

                <div className="card__acts">
                  <Button
                    tone="primary"
                    disabled={busy}
                    onClick={(): void => void decide('approved')}
                  >
                    Approve this action
                  </Button>

                  <Button
                    tone="secondary"
                    disabled={busy}
                    onClick={(): void => void decide('rejected')}
                  >
                    Refuse
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {running ? null : (
            <div className="done">
              <p className="done__what">
                {live.failure === null
                  ? `This session is ${statusWords(live.status).toLowerCase()}.`
                  : live.failure.message}
              </p>
              <p className="done__why">
                Nothing more will happen here. Start another session from the dashboard.
              </p>
            </div>
          )}

          <div ref={bottom} />
        </div>
      </div>

      {running ? (
        <div className="say">
          <div className="say__inner">
            {problem === null ? null : (
              <p className="note note--problem" role="alert">
                <span className="note__mark" aria-hidden="true" />
                {problem}
              </p>
            )}

            <div className="say__box">
              <textarea
                className="say__input"
                aria-label={live.question === null ? 'Message Nimbus' : 'Your answer'}
                value={text}
                disabled={busy}
                placeholder={
                  live.question === null
                    ? 'Say something to steer the run'
                    : 'Answer the question above'
                }
                onKeyDown={onKeyDown}
                onChange={(event): void => {
                  setText(event.target.value);
                }}
              />

              <div className="say__foot">
                <span className="say__hint">Enter sends, shift and enter makes a new line</span>

                <Button
                  tone="primary"
                  className="say__send"
                  disabled={busy || text.trim() === ''}
                  onClick={(): void => void send()}
                >
                  {live.question === null ? 'Send' : 'Answer'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
