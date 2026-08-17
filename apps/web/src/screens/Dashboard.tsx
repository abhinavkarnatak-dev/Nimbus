import {
  CreateSessionResponseSchema,
  LIMITS,
  taskThinness,
  wordsStillNeeded,
  type RepositorySummary,
  type SelectableModel,
  type SessionSummary,
} from '@nimbus/contracts';
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';

import type { ApiClient, CsrfSource } from '../api/client.js';
import { ApiError, NetworkError } from '../api/errors.js';
import { ROUTE_PATHS, sessionPath } from '../app/routes.js';
import { navigate } from '../app/useRoute.js';
import { ACCEPT_ATTRIBUTE, sizeWords } from '../attachments/attachments.js';
import { useAttachments } from '../attachments/useAttachments.js';
import { newPrefixedId } from '../lib/id.js';
import { plainText } from '../render/safe.js';
import { statusWords, toneFor, whenWords } from '../sessions/status.js';
import {
  activeMention,
  fullName,
  insertMention,
  matchRepositories,
  mentionedRepository,
  withoutMentions,
} from '../sessions/mention.js';
import type { InstallationHandle } from '../github/useInstallation.js';
import type { SessionsHandle } from '../sessions/useSessions.js';
import { Button } from '../ui/Button.js';

function startProblem(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'Nimbus is not answering. Check your connection and try again.';
  }

  if (!(error instanceof ApiError)) {
    return 'That did not start. Try again.';
  }

  if (error.code === 'TASK_TOO_BROAD') {
    return error.message;
  }

  const known: Partial<Record<string, string>> = {
    ACTIVE_SESSION_EXISTS: 'You already have a session running. Finish or cancel it first.',
    REPOSITORY_NOT_AVAILABLE: 'Nimbus can no longer see that repository. Check it on GitHub.',
    REPOSITORY_NOT_PUBLIC: 'Nimbus only works on public repositories.',
    GITHUB_NOT_CONNECTED: 'Connect GitHub before starting a session.',
    VALIDATION_FAILED: `Describe the change in at least ${String(LIMITS.taskMinChars)} characters.`,
    AGENT_SESSIONS_DISABLED: 'Starting sessions is switched off on this deployment.',
  };

  return known[error.code] ?? 'That did not start. Try again.';
}

function StatusPill({ status }: { status: SessionSummary['status'] }): React.JSX.Element {
  return (
    <span className="status" data-tone={toneFor(status)}>
      <span className="status__dot" aria-hidden="true" />
      {statusWords(status)}
    </span>
  );
}

function RunRow({ session, now }: { session: SessionSummary; now: number }): React.JSX.Element {
  return (
    <a className="run-row" href={sessionPath(session.sessionId)}>
      <span className="run-row__task">{plainText(session.task, 240)}</span>
      <span className="run-row__meta">
        <StatusPill status={session.status} />
        <span>{whenWords(session.lastActivityAt, now)}</span>
        {session.pullRequest === null ? null : <span>#{session.pullRequest.number}</span>}
      </span>
    </a>
  );
}

export interface DashboardProps {
  api: ApiClient;
  csrf: CsrfSource;
  sessions: SessionsHandle;
  installation: InstallationHandle;
}

export function Dashboard({
  api,
  csrf,
  sessions,
  installation,
}: DashboardProps): React.JSX.Element {
  const repositories = installation.repositories;
  const [task, setTask] = useState('');
  const [model, setModel] = useState('');
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const attachments = useAttachments(api, csrf);

  const now = Date.now();
  const active = sessions.activeSessionId;
  const picked = mentionedRepository(task, repositories);
  const spoken = withoutMentions(task, repositories);
  const tooLong = task.length > LIMITS.taskMaxChars;
  const thin = spoken === '' ? null : taskThinness(spoken);
  const shortBy = wordsStillNeeded(spoken);
  const matches = mention === null ? [] : matchRepositories(repositories, mention.query);
  const ready = picked !== null && !tooLong && active === null && !attachments.busy;

  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, mention]);

  const readMention = (value: string, caret: number): void => {
    const found = activeMention(value, caret);
    setMention(found);
    setHighlighted(0);
  };

  const choose = (repository: RepositorySummary): void => {
    if (mention === null) {
      return;
    }

    const next = insertMention(task, mention, repository);
    setTask(next.text);
    setMention(null);

    globalThis.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const dropped = [...event.clipboardData.files];

    if (dropped.length === 0) {
      return;
    }

    event.preventDefault();
    attachments.add(dropped);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention !== null && matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((at) => (at + 1) % matches.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((at) => (at - 1 + matches.length) % matches.length);
        return;
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        const wanted = matches[highlighted];

        if (wanted !== undefined) {
          event.preventDefault();
          choose(wanted);
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void start(event);
    }
  };

  const start = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();

    if (!ready) {
      return;
    }

    setStarting(true);
    setProblem(null);

    try {
      const created = await api.post(
        '/sessions',
        {
          repositoryId: picked.repositoryId,
          task: spoken,
          attachmentIds: attachments.readyIds,
          idempotencyKey: newPrefixedId('idk'),
          ...(model === '' ? {} : { model: { textModel: model } }),
        },
        CreateSessionResponseSchema,
      );

      attachments.clear();
      await sessions.refresh();
      navigate(sessionPath(created.session.sessionId));
    } catch (error) {
      setProblem(startProblem(error));
      setStarting(false);
      void sessions.refresh();
    }
  };

  return (
    <div className="dash">
      <aside className="rail" aria-label="Your sessions">
        <div className="rail__body">
          <div className="rail__group">
            <p className="rail__word">
              <span>Recent</span>
              <span>{String(sessions.sessions.length)}</span>
            </p>

            {sessions.sessions.length === 0 ? (
              <p className="empty__why">Nothing yet. The first session you start appears here.</p>
            ) : (
              <div className="history__list">
                {sessions.sessions.map((one) => (
                  <RunRow key={one.sessionId} session={one} now={now} />
                ))}
              </div>
            )}
          </div>
        </div>

        <a className="rail__settings" href={ROUTE_PATHS.settings}>
          <span className="rail__gear" aria-hidden="true">
            &#9881;
          </span>
          Settings
        </a>
      </aside>

      <div className="dash__main">
        <div className="dash__inner">
          <header className="dash__head">
            <p className="dash__eyebrow">Nimbus</p>
            <h1 className="dash__title">What should change?</h1>
            <p className="dash__sub">
              One repository, one small task. Nimbus works in an isolated sandbox and opens a pull
              request for you to review.
            </p>
          </header>

          <form className="compose" onSubmit={(event): void => void start(event)} noValidate>
            {problem === null ? null : (
              <p className="note note--problem" role="alert">
                <span className="note__mark" aria-hidden="true" />
                {problem}
              </p>
            )}

            {active !== null ? (
              <p className="note" role="status">
                <span className="note__mark" aria-hidden="true" />
                One session runs at a time.{' '}
                <a href={sessionPath(active)}>Open the one that is running</a> to watch, answer or
                cancel it.
              </p>
            ) : null}

            <div className="composer" data-locked={active !== null}>
              {mention === null ? null : (
                <div className="picker" role="listbox" aria-label="Repositories">
                  {matches.length === 0 ? (
                    <p className="picker__none">
                      {repositories.length === 0
                        ? 'No repository is shared with Nimbus yet.'
                        : 'No repository matches that.'}
                    </p>
                  ) : (
                    matches.map((one, at) => (
                      <button
                        className="picker__item"
                        type="button"
                        key={one.repositoryId}
                        ref={at === highlighted ? activeOption : null}
                        role="option"
                        aria-selected={at === highlighted}
                        data-active={at === highlighted}
                        onMouseEnter={(): void => {
                          setHighlighted(at);
                        }}
                        onClick={(): void => {
                          choose(one);
                        }}
                      >
                        <span className="picker__name">{fullName(one)}</span>
                        <span className="picker__branch">{one.defaultBranch}</span>
                      </button>
                    ))
                  )}
                </div>
              )}

              {attachments.held.length === 0 ? null : (
                <div className="clips">
                  {attachments.held.map((one) => (
                    <div className="clip" key={one.localId} data-problem={one.problem !== null}>
                      {one.previewUrl === null ? (
                        <span className="clip__kind" aria-hidden="true">
                          txt
                        </span>
                      ) : (
                        <img className="clip__thumb" src={one.previewUrl} alt="" />
                      )}

                      <span className="clip__body">
                        <span className="clip__name">{one.name}</span>
                        <span className="clip__note">
                          {one.problem ??
                            (one.saved === null
                              ? `${String(Math.round(one.progress * 100))}%`
                              : sizeWords(one.byteSize))}
                        </span>
                      </span>

                      <button
                        className="clip__drop"
                        type="button"
                        aria-label={`Remove ${one.name}`}
                        onClick={(): void => {
                          attachments.remove(one.localId);
                        }}
                      >
                        &times;
                      </button>

                      {one.saved === null && one.problem === null ? (
                        <span
                          className="clip__bar"
                          style={{ width: `${String(Math.round(one.progress * 100))}%` }}
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              <textarea
                className="composer__input"
                ref={input}
                aria-label="What should change"
                value={task}
                disabled={active !== null}
                placeholder="Ask Nimbus to fix a bug or make a small change."
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onChange={(event): void => {
                  setTask(event.target.value);
                  readMention(event.target.value, event.target.selectionStart);
                }}
                onClick={(event): void => {
                  readMention(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onBlur={(): void => {
                  globalThis.setTimeout(() => {
                    setMention(null);
                  }, 120);
                }}
              />

              <div className="composer__foot">
                <input
                  ref={chooser}
                  type="file"
                  className="visually-hidden"
                  multiple
                  accept={ACCEPT_ATTRIBUTE}
                  onChange={(event): void => {
                    attachments.add([...(event.target.files ?? [])]);
                    event.target.value = '';
                  }}
                />

                <button
                  className="composer__attach"
                  type="button"
                  aria-label="Attach a file or image"
                  title="Attach a file or image"
                  disabled={active !== null || attachments.room === 0}
                  onClick={(): void => {
                    chooser.current?.click();
                  }}
                >
                  +
                </button>

                {picked === null ? (
                  <span className="composer__hint">
                    Type <kbd>@</kbd> to pick a repository
                  </span>
                ) : (
                  <span className="composer__repo">{fullName(picked)}</span>
                )}

                <div className="composer__end">
                  <select
                    className="composer__model"
                    aria-label="Model"
                    value={model}
                    disabled={sessions.models.length === 0 || active !== null}
                    onChange={(event): void => {
                      setModel(event.target.value);
                    }}
                  >
                    <option value="">Auto</option>
                    {sessions.models.map((one: SelectableModel) => (
                      <option key={one.id} value={one.id}>
                        {one.id}
                      </option>
                    ))}
                  </select>

                  <Button
                    type="submit"
                    tone="primary"
                    className="composer__send"
                    disabled={!ready || starting}
                  >
                    {starting ? 'Starting' : 'Start'}
                  </Button>
                </div>
              </div>
            </div>

            {attachments.refusals.length === 0 ? null : (
              <p className="note note--problem" role="alert">
                <span className="note__mark" aria-hidden="true" />
                {attachments.refusals.join(' ')}
              </p>
            )}

            <p className="compose__foot-row">
              <span className="compose__guide" data-thin={thin !== null}>
                {thin === null
                  ? 'Nimbus can act on this.'
                  : thin === 'too_short'
                    ? 'Say a little more about what should change.'
                    : `Name the file, function or behaviour. ${
                        shortBy === 1
                          ? 'One more specific word'
                          : `${String(shortBy)} more specific words`
                      } and this is actionable.`}
              </span>

              <span className="compose__count" data-over={tooLong}>
                {String(task.length)} / {String(LIMITS.taskMaxChars)}
              </span>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
