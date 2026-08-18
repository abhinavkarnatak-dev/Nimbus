import {
  AnswerSessionBodySchema,
  ApprovalRecordSchema,
  CancelSessionResponseSchema,
  CreateSessionResponseSchema,
  PostMessageResponseSchema,
  SessionSummarySchema,
  type ApprovalDecision,
  type SessionId,
} from '@nimbus/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { ApiClient } from '../api/client.js';
import { ApiError, NetworkError } from '../api/errors.js';
import { newPrefixedId } from '../lib/id.js';
import { plainText } from '../render/safe.js';
import { answered, decided, type LiveSession } from '../sessions/live.js';
import type { ManualPrState } from '../sessions/Panels.js';
import {
  ChangesPane,
  ChecksPane,
  ProgressPane,
  PullRequestPane,
  ShellPane,
} from '../sessions/Panels.js';
import { Rail } from '../sessions/Rail.js';
import { RailToggle } from '../sessions/RailToggle.js';
import { isLive, statusWords, toneFor } from '../sessions/status.js';
import { SESSION_TABS, TAB_WORDS, tabCount, type SessionTab } from '../sessions/tabs.js';
import type { LiveSessionHandle } from '../sessions/useLiveSession.js';
import type { SessionsHandle } from '../sessions/useSessions.js';
import { Button } from '../ui/Button.js';
import { Skeleton } from '../ui/Skeleton.js';

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

function paneFor(
  tab: SessionTab,
  live: LiveSession,
  prStates: Record<number, ManualPrState>,
  onPrState: (number: number, state: ManualPrState) => void,
): React.JSX.Element {
  if (tab === 'progress') {
    return <ProgressPane live={live} />;
  }
  if (tab === 'changes') {
    return <ChangesPane live={live} />;
  }
  if (tab === 'checks') {
    return <ChecksPane live={live} />;
  }
  if (tab === 'shell') {
    return <ShellPane live={live} />;
  }
  return <PullRequestPane live={live} states={prStates} onState={onPrState} />;
}

export interface SessionScreenProps {
  api: ApiClient;
  sessionId: SessionId;
  view: LiveSessionHandle;
  sessions: SessionsHandle;
}

export function Session({ api, sessionId, view, sessions }: SessionScreenProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tab, setTab] = useState<SessionTab>('progress');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [prStates, setPrStates] = useState<Record<number, ManualPrState>>({});
  const bottom = useRef<HTMLDivElement>(null);

  const detail = view.detail;
  const live = view.live;
  const running = live !== null && isLive(live.status);
  const composerDisabled = busy || (running && live.question === null);
  const refreshSessions = sessions.refresh;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [live?.messages.length, live?.approval, live?.question]);

  useEffect(() => {
    void refreshSessions();
  }, [live?.status, refreshSessions]);

  useEffect(() => {
    if (detail === null || live === null) return;
    const held = sessions.sessions.find((session) => session.sessionId === detail.sessionId);
    if (held === undefined) return;
    if (
      held.status === live.status &&
      held.runStatus === live.runStatus &&
      held.deliveryStatus === live.deliveryStatus &&
      held.pullRequest?.number === live.pullRequest?.number &&
      held.pullRequest?.headSha === live.pullRequest?.headSha &&
      held.lastActivityAt === (live.messages.at(-1)?.sentAt ?? held.lastActivityAt)
    )
      return;
    sessions.replaceSession({
      ...held,
      status: live.status,
      runStatus: live.runStatus,
      deliveryStatus: live.deliveryStatus,
      pullRequest: live.pullRequest,
      lastActivityAt: live.messages.at(-1)?.sentAt ?? held.lastActivityAt,
    });
  }, [detail, live, sessions.replaceSession, sessions.sessions]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setClock(Date.now());
    }, 1_000);
    return (): void => {
      window.clearInterval(timer);
    };
  }, [running]);

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
      <div className="run run--loading" aria-label="Loading session">
        <Rail sessions={sessions} openSessionId={sessionId} api={api} />
        <div className="work">
          <header className="run__head">
            <div className="run__what">
              <Skeleton shape="line" width="42%" />
              <Skeleton shape="line" width="28%" />
            </div>
          </header>
          <section className="chat">
            <div className="thread">
              <div className="thread__inner session-skeleton">
                <Skeleton shape="line" width="58%" />
                <Skeleton shape="block" height="7rem" />
                <Skeleton shape="line" width="42%" />
              </div>
            </div>
          </section>
        </div>
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
          { message: said, idempotencyKey: newPrefixedId('idk') },
          PostMessageResponseSchema,
        );

        view.change((held) => ({
          ...held,
          messages: [...held.messages, posted.message],
          ...(held.status === 'awaiting_user' && held.question === null
            ? {
                status: 'queued',
                progress: { ...held.progress, currentActivity: 'queued for your follow-up' },
              }
            : {}),
        }));
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

  const openPullRequest = (): void => {
    setTab('pull_request');
    setInspectorOpen(true);
  };

  const setPrState = (number: number, state: ManualPrState): void => {
    setPrStates((held) => {
      const next = { ...held, [number]: state };
      return next;
    });
    void api
      .patch(`/sessions/${sessionId}/pull-request-state`, { number, state }, SessionSummarySchema)
      .then((saved) => {
        setPrStates(saved.manualPrStates);
        sessions.replaceSession(saved);
      })
      .catch(() => {
        void view.refresh();
      });
  };

  useEffect(() => {
    setPrStates(detail.manualPrStates);
  }, [detail.manualPrStates]);

  const elapsedSinceLastUser = (at: number): number => {
    const last = [...live.messages.slice(0, at)]
      .reverse()
      .find((message) => message.role === 'user');
    return Math.max(
      1,
      Math.round(
        (Date.parse(live.messages[at]?.sentAt ?? '') - Date.parse(last?.sentAt ?? '')) / 1_000,
      ),
    );
  };
  const prLines = (message: string): { added: string; removed: string } | null => {
    const matched = /\+(\d+)\s+−(\d+)\s+lines/.exec(message);
    return matched === null ? null : { added: matched[1] ?? '0', removed: matched[2] ?? '0' };
  };

  return (
    <div className="run" data-rail-open={railOpen}>
      <RailToggle
        onOpen={(): void => {
          setRailOpen(true);
          setInspectorOpen(false);
        }}
      />

      <Rail
        sessions={sessions}
        openSessionId={sessionId}
        api={api}
        onClose={(): void => {
          setRailOpen(false);
        }}
      />
      {railOpen || inspectorOpen ? (
        <button
          className="run__drawer-scrim"
          type="button"
          aria-label="Close open panel"
          onClick={(): void => {
            setRailOpen(false);
            setInspectorOpen(false);
          }}
        />
      ) : null}

      <div className="work">
        <header className="run__head">
          <div className="run__what">
            <p className="run__task">{plainText(detail.title, 100)}</p>

            <p className="run__where">
              <svg className="run__github" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.23.49-2.7-.95-2.7-.95-.36-.93-.89-1.18-.89-1.18-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.24 1.89.88 2.35.67.07-.52.28-.88.51-1.08-1.78-.2-3.65-.89-3.65-3.96 0-.88.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .68-.22 2.2.82A7.67 7.67 0 0 1 8 4.8c.68 0 1.37.09 2.01.27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.27.83 2.15 0 3.08-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
              </svg>
              {detail.repository.owner}/{detail.repository.name}
            </p>
          </div>

          <div className="run__tools">
            {live.pullRequest === null ? (
              live.status !== 'queued' &&
              (live.status !== 'awaiting_user' ||
                live.question !== null ||
                live.approval !== null) ? (
                <span className="status" data-tone={toneFor(live.status)}>
                  <span className="status__dot" aria-hidden="true" />
                  {statusWords(live.status)}
                </span>
              ) : null
            ) : (
              <button
                className="run__pr-ready"
                data-state={prStates[live.pullRequest.number] ?? 'open'}
                type="button"
                onClick={openPullRequest}
                aria-label={`Show pull request #${String(live.pullRequest.number)}`}
                title={`Show pull request #${String(live.pullRequest.number)}`}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5Zm0 9.5a.75.75 0 1 0 0 1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
                </svg>
                <span>
                  {prStates[live.pullRequest.number] === 'merged'
                    ? 'PR merged'
                    : prStates[live.pullRequest.number] === 'closed'
                      ? 'PR closed'
                      : `#${String(live.pullRequest.number)}`}
                </span>
              </button>
            )}

            {running ? (
              <Button tone="danger" disabled={busy} onClick={(): void => void stop()}>
                End
              </Button>
            ) : null}

            <button
              className="run__split-toggle"
              type="button"
              aria-label={inspectorOpen ? 'Hide session details' : 'Show session details'}
              aria-pressed={inspectorOpen}
              title={inspectorOpen ? 'Hide session details' : 'Show session details'}
              onClick={(): void => {
                setInspectorOpen((open) => !open);
                setRailOpen(false);
              }}
            >
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4.27 4.041c-.568.097-1.116.401-1.542.857-.288.308-.487.652-.615 1.062l-.093.3V17.74l.093.3c.143.458.342.782.703 1.144.362.361.686.56 1.144.703l.3.093h15.48l.3-.093c.458-.143.782-.342 1.144-.703.361-.362.56-.686.703-1.144l.093-.3V6.26l-.093-.3c-.262-.842-.948-1.547-1.778-1.829l-.329-.111-7.66-.006c-4.213-.003-7.745.009-7.85.027M15 12.021v6.501l-5.25-.011c-4.97-.011-5.26-.015-5.438-.084a1.505 1.505 0 0 1-.678-.645l-.114-.242V6.46l.102-.22c.135-.292.306-.465.597-.605l.24-.115h10.54v6.501m4.78-6.386c.291.14.462.313.597.605l.102.22.001 5.54v5.54l-.114.242c-.135.284-.404.54-.678.643-.164.061-.376.072-1.678.086l-1.49.015v-13.006h3.02l.24.115"
                  stroke="none"
                  fill="currentColor"
                />
              </svg>
            </button>
          </div>
        </header>

        <div className="run__split" data-inspector-open={inspectorOpen}>
          <section className="chat" aria-label="Conversation">
            <div className="thread">
              <div className="thread__inner">
                <AnimatePresence initial={false}>
                  {live.messages.map((one, index) => (
                    <motion.div
                      key={one.messageId}
                      className="turn"
                      data-role={one.role}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                    >
                      {one.role === 'agent' ? (
                        <p className="turn__worked">
                          &gt; Worked for {String(elapsedSinceLastUser(index))}s
                        </p>
                      ) : null}
                      {one.role === 'agent' &&
                      /^Worked for \d+s\. PR #\d+ (?:is ready|was created|was updated)/.test(
                        one.text,
                      ) &&
                      live.pullRequest !== null ? (
                        <div className="turn__pr-card">
                          <p className="turn__commit">
                            {one.text
                              .replace(
                                /^Worked for \d+s\. PR #\d+ (?:is ready|was created|was updated) for /,
                                '',
                              )
                              .split('. ')[0] ?? 'Nimbus change'}
                          </p>
                          <a
                            className="turn__pr-meta"
                            href={live.pullRequest.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <svg className="turn__pr-icon" viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
                            </svg>
                            <span>
                              {detail.repository.name} #{String(live.pullRequest.number)}
                            </span>
                            <span className="turn__pr-separator" aria-hidden="true">
                              &bull;
                            </span>
                            <strong className="turn__pr-added">
                              +{prLines(one.text)?.added ?? '—'}
                            </strong>
                            <strong className="turn__pr-removed">
                              −{prLines(one.text)?.removed ?? '—'}
                            </strong>
                            <span className="turn__pr-separator" aria-hidden="true">
                              &bull;
                            </span>
                            <span>nimbus-cloud-agent[bot]</span>
                          </a>
                          <p className="turn__pr-summary">
                            {detail.title} pushed as a PR:{' '}
                            <a href={live.pullRequest.url} target="_blank" rel="noreferrer">
                              {detail.repository.name}#{String(live.pullRequest.number)}
                            </a>
                          </p>
                        </div>
                      ) : (
                        <p className="turn__body">{one.text.replace(/^Worked for \d+s\. /, '')}</p>
                      )}
                    </motion.div>
                  ))}

                  {running && live.status !== 'awaiting_user' && live.question === null ? (
                    <motion.div
                      className="thread__working"
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <span className="thread__working-dot" aria-hidden="true" />
                      <span>
                        {live.progress.currentActivity ?? 'Working'} (
                        {String(
                          Math.max(
                            1,
                            Math.round(
                              (clock -
                                Date.parse(
                                  live.messages.at(-1)?.sentAt ?? new Date(clock).toISOString(),
                                )) /
                                1_000,
                            ),
                          ),
                        )}
                        s)
                      </span>
                    </motion.div>
                  ) : null}

                  {live.question === null ? null : (
                    <motion.div
                      key="question"
                      className="card card--ask"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <p className="card__word">
                        <span className="card__pulse" aria-hidden="true" />
                        Nimbus is awaiting instructions
                      </p>
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
                          tone="danger"
                          disabled={busy}
                          onClick={(): void => void decide('rejected')}
                        >
                          Refuse
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {running ||
                (live.failure === null && live.deliveryStatus === 'no_changes') ? null : (
                  <>
                    <div className="done">
                      <p className="done__what">
                        {live.failure === null
                          ? live.deliveryStatus === 'pr_created'
                            ? 'A pull request is ready for review.'
                            : live.deliveryStatus === 'pr_updated'
                              ? 'The pull request was updated.'
                              : 'Done.'
                          : live.failure.message}
                      </p>
                      <p className="done__why">
                        {live.failure?.code === 'CHECKS_FAILED'
                          ? 'The compile check failed. Ask Nimbus to retry or make another change.'
                          : live.deliveryStatus === 'pr_updated'
                            ? 'You can continue working in this session.'
                            : live.deliveryStatus === 'pr_created'
                              ? 'Ask Nimbus for another change below and it will update this pull request.'
                              : 'You can ask for another change below.'}
                      </p>
                    </div>
                  </>
                )}

                <div ref={bottom} />
              </div>
            </div>

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
                    disabled={composerDisabled}
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
                      disabled={composerDisabled || text.trim() === ''}
                      onClick={(): void => void send()}
                    >
                      {live.question === null ? 'Send' : 'Answer'}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {inspectorOpen ? (
            <section className="pane" aria-label="What the run did">
              <button
                className="pane__close"
                type="button"
                aria-label="Hide session details"
                onClick={(): void => {
                  setInspectorOpen(false);
                }}
              >
                ×
              </button>

              <div className="pane__tabs" role="tablist" aria-label="What to look at">
                {SESSION_TABS.map((one) => {
                  const count = tabCount(one, live);

                  return (
                    <button
                      className="pane__tab"
                      type="button"
                      key={one}
                      role="tab"
                      aria-selected={tab === one}
                      data-active={tab === one}
                      onClick={(): void => {
                        setTab(one);
                      }}
                    >
                      {TAB_WORDS[one]}
                      {count === null ? null : <span className="pane__count">{String(count)}</span>}
                    </button>
                  );
                })}
              </div>

              <div className="pane__body" role="tabpanel">
                {paneFor(tab, live, prStates, setPrState)}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
