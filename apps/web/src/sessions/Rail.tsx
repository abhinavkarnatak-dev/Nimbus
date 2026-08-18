import {
  DeleteSessionResponseSchema,
  SessionSummarySchema,
  type SessionSummary,
} from '@nimbus/contracts';

import { ROUTE_PATHS, sessionPath } from '../app/routes.js';
import { navigate } from '../app/useRoute.js';
import { plainText } from '../render/safe.js';
import { statusWords, toneFor, whenWords } from './status.js';
import type { SessionsHandle } from './useSessions.js';
import type { ApiClient } from '../api/client.js';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface RailProps {
  sessions: SessionsHandle;
  openSessionId?: string;
  api: ApiClient;
  prStates?: Record<string, 'open' | 'merged' | 'closed'>;
  onClose?: () => void;
}

function navigateFromRail(event: React.MouseEvent<HTMLAnchorElement>, path: string): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey
  ) {
    return;
  }

  event.preventDefault();
  navigate(path);
}

function RunRow({
  session,
  now,
  open,
  api,
  refresh,
  replaceSession,
  prState = 'open',
}: {
  session: SessionSummary;
  now: number;
  open: boolean;
  api: ApiClient;
  refresh: () => Promise<void>;
  replaceSession: (session: SessionSummary) => void;
  prState?: 'open' | 'merged' | 'closed';
}): React.JSX.Element {
  const pullRequest = session.pullRequest;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing) setTitle(session.title);
  }, [editing, session.title]);
  useEffect(() => {
    if (!menuOpen) return;

    const closeFromOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !row.current?.contains(event.target)) {
        setMenuOpen(false);
        setConfirmingDelete(false);
      }
    };

    document.addEventListener('pointerdown', closeFromOutside);
    return (): void => document.removeEventListener('pointerdown', closeFromOutside);
  }, [menuOpen]);
  const rename = async (): Promise<void> => {
    const nextTitle = title.trim();
    if (nextTitle === '' || savingName) return;

    setRenameProblem(null);
    setSavingName(true);
    const optimistic = { ...session, title: nextTitle };
    replaceSession(optimistic);

    try {
      const renamed = await api.patch(
        `/sessions/${session.sessionId}/title`,
        { title: nextTitle },
        SessionSummarySchema,
      );
      setTitle(renamed.title);
      replaceSession(renamed);
      setEditing(false);
    } catch {
      replaceSession(session);
      setTitle(session.title);
      setRenameProblem('Could not save the name. Try again.');
    } finally {
      setSavingName(false);
    }
  };
  const remove = async (): Promise<void> => {
    await api.delete(`/sessions/${session.sessionId}`, DeleteSessionResponseSchema);
    await refresh();
    if (open) navigate(ROUTE_PATHS.dashboard);
  };

  return (
    <div ref={row} className="run-row" data-open={open}>
      {editing ? (
        <div className="run-row__session">
          <span className="run-row__edit">
            <input
              autoFocus
              value={title}
              maxLength={120}
              onChange={(event): void => setTitle(event.target.value)}
              onKeyDown={(event): void => {
                if (event.key === 'Enter') void rename();
                if (event.key === 'Escape') {
                  setTitle(session.title);
                  setEditing(false);
                }
              }}
            />
            <button type="button" aria-label="Save name" onClick={(): void => void rename()}>
              &#10003;
            </button>
            <button
              type="button"
              aria-label="Cancel rename"
              onClick={(): void => {
                setTitle(session.title);
                setEditing(false);
              }}
            >
              &#10005;
            </button>
          </span>
          {renameProblem === null ? null : (
            <span className="run-row__rename-problem">{renameProblem}</span>
          )}
          <span className="run-row__repo">
            <svg className="run-row__github" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.23.49-2.7-.95-2.7-.95-.36-.93-.89-1.18-.89-1.18-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.24 1.89.88 2.35.67.07-.52.28-.88.51-1.08-1.78-.2-3.65-.89-3.65-3.96 0-.88.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .68-.22 2.2.82A7.67 7.67 0 0 1 8 4.8c.68 0 1.37.09 2.01.27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.27.83 2.15 0 3.08-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
            </svg>
            {session.repository.name}
          </span>
        </div>
      ) : (
        <a
          className="run-row__session"
          href={sessionPath(session.sessionId)}
          aria-current={open ? 'page' : undefined}
          onClick={(event): void => navigateFromRail(event, sessionPath(session.sessionId))}
        >
          <span className="run-row__task">{plainText(title, 240)}</span>
          <span className="run-row__repo">
            <svg className="run-row__github" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.23.49-2.7-.95-2.7-.95-.36-.93-.89-1.18-.89-1.18-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.24 1.89.88 2.35.67.07-.52.28-.88.51-1.08-1.78-.2-3.65-.89-3.65-3.96 0-.88.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .68-.22 2.2.82A7.67 7.67 0 0 1 8 4.8c.68 0 1.37.09 2.01.27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.27.83 2.15 0 3.08-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
            </svg>
            {session.repository.name}
          </span>
        </a>
      )}
      <span className="run-row__meta">
        {!editing ? (
          <button
            className="run-row__more"
            type="button"
            aria-label={`Session options for ${session.title}`}
            title="Session options"
            onClick={(): void => {
              setConfirmingDelete(false);
              setMenuOpen((value) => !value);
            }}
          >
            &#8942;
          </button>
        ) : null}
        {menuOpen ? (
          <span className="run-row__menu">
            {confirmingDelete ? (
              <>
                <span className="run-row__confirm">Delete this session?</span>
                <span className="run-row__confirm-actions">
                  <button type="button" onClick={(): void => setConfirmingDelete(false)}>
                    Cancel
                  </button>
                  <button type="button" onClick={(): void => void remove()}>
                    Delete
                  </button>
                </span>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={(): void => {
                    setMenuOpen(false);
                    setRenameProblem(null);
                    setEditing(true);
                  }}
                >
                  Rename
                </button>
                <button type="button" onClick={(): void => setConfirmingDelete(true)}>
                  Delete
                </button>
              </>
            )}
          </span>
        ) : null}
        {session.status === 'awaiting_user' || session.status === 'queued' ? null : (
          <span
            className="status"
            data-tone={pullRequest === null ? toneFor(session.status) : prState === 'closed' ? 'failed' : prState === 'merged' ? 'merged' : 'done'}
          >
            <span className="status__dot" aria-hidden="true" />
            {pullRequest === null
              ? statusWords(session.status)
              : prState === 'merged'
                ? 'PR merged'
                : prState === 'closed'
                  ? 'PR closed'
                  : 'PR ready'}
          </span>
        )}
        {pullRequest === null ? null : (
            <a
              className="run-row__pr"
              data-state={prState}
            href={pullRequest.url}
            aria-label={`Open pull request #${String(pullRequest.number)} on GitHub`}
            title={`Open pull request #${String(pullRequest.number)} on GitHub`}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
            </svg>
            <span>#{pullRequest.number}</span>
          </a>
        )}
        <span>{whenWords(session.lastActivityAt, now)}</span>
      </span>
    </div>
  );
}

export function Rail({ sessions, openSessionId, api, prStates = {}, onClose }: RailProps): React.JSX.Element {
  const now = Date.now();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sortOpen, setSortOpen] = useState(false);
  const [sortBy, setSortBy] = useState<'updated' | 'created'>('updated');
  const visibleSessions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matching = sessions.sessions.filter((session) => {
      if (needle === '') return true;
      return `${session.title} ${session.repository.name}`.toLocaleLowerCase().includes(needle);
    });

    return [...matching].sort((left, right) => {
      const leftAt = sortBy === 'updated' ? left.lastActivityAt : left.createdAt;
      const rightAt = sortBy === 'updated' ? right.lastActivityAt : right.createdAt;
      return Date.parse(rightAt) - Date.parse(leftAt);
    });
  }, [query, sessions.sessions, sortBy]);

  return (
    <aside className="rail" aria-label="Your sessions">
      <button className="rail__close" type="button" aria-label="Hide sessions" onClick={onClose}>×</button>
      <a
        className="rail__new button button--secondary"
        href={ROUTE_PATHS.dashboard}
        onClick={(event): void => {
          navigateFromRail(event, ROUTE_PATHS.dashboard);
        }}
      >
        <span className="rail__new-mark" aria-hidden="true">
          +
        </span>
        New session
      </a>

      <div className="rail__sessions">
        <div className="rail__header">
          {searchOpen ? (
            <label className="rail__search-inline">
              <span className="visually-hidden">Search sessions</span>
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="10.8" cy="10.8" r="6.3" />
                <path d="m16 16 4.2 4.2" />
              </svg>
              <input
                autoFocus
                type="search"
                value={query}
                placeholder="Search sessions"
                onChange={(event): void => setQuery(event.target.value)}
              />
              <button
                type="button"
                aria-label="Close session search"
                title="Close search"
                onClick={(): void => {
                  setQuery('');
                  setSearchOpen(false);
                }}
              >
                &#10005;
              </button>
            </label>
          ) : (
            <div className="rail__word">
              <span>Recent</span>
              <span className="rail__controls">
                <button
                  className="rail__control"
                  type="button"
                  aria-label="Search sessions"
                  aria-pressed={searchOpen}
                  title="Search sessions"
                  onClick={(): void => setSearchOpen((open) => !open)}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="10.8" cy="10.8" r="6.3" />
                    <path d="m16 16 4.2 4.2" />
                  </svg>
                </button>
                <button
                  className="rail__control"
                  type="button"
                  aria-label={`Sort sessions by last ${sortBy === 'updated' ? 'updated' : 'created'}`}
                  aria-expanded={sortOpen}
                  title="Sort sessions"
                  onClick={(): void => setSortOpen((open) => !open)}
                >
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M6.78 2.9c-.11.029-.29.103-.4.164-.245.134-3.615 3.468-3.768 3.727-.339.574.221 1.29.853 1.089.122-.039.456-.349 1.584-1.473l1.43-1.425.01 7.679.011 7.679.084.16c.114.22.361.387.603.408.242.022.494-.1.671-.322l.122-.153.01-7.726.011-7.725 1.409 1.407c1.437 1.435 1.553 1.531 1.84 1.531.33 0 .689-.319.735-.651.051-.376.055-.372-1.915-2.335C8.821 3.688 8.204 3.101 8.08 3.038c-.392-.197-.89-.25-1.3-.138m9.68.076a1.006 1.006 0 0 0-.232.159c-.244.229-.228-.325-.228 8.053v7.671l-1.43-1.425c-1.536-1.53-1.554-1.544-1.915-1.504-.489.056-.793.599-.581 1.038.107.221 3.54 3.649 3.807 3.802.226.128.608.23.866.23.236 0 .593-.088.824-.204.111-.055.795-.707 1.982-1.89.997-.993 1.832-1.842 1.856-1.885.135-.244.09-.648-.094-.848a.975.975 0 0 0-.866-.191c-.099.041-.612.524-1.539 1.449l-1.39 1.386V11.271c0-5.292-.013-7.608-.044-7.75a1.018 1.018 0 0 0-.148-.328c-.202-.24-.595-.338-.868-.217"
                      stroke="none"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                {sortOpen ? (
                  <span className="rail__sort-menu">
                    <button
                      type="button"
                      data-active={sortBy === 'updated'}
                      onClick={(): void => {
                        setSortBy('updated');
                        setSortOpen(false);
                      }}
                    >
                      Last updated
                    </button>
                    <button
                      type="button"
                      data-active={sortBy === 'created'}
                      onClick={(): void => {
                        setSortBy('created');
                        setSortOpen(false);
                      }}
                    >
                      Last created
                    </button>
                  </span>
                ) : null}
              </span>
            </div>
          )}
        </div>

        <div className="rail__body">
          {sessions.sessions.length === 0 ? (
            <p className="empty__why">Nothing yet. The first session you start appears here.</p>
          ) : visibleSessions.length === 0 ? (
            <p className="empty__why">No sessions match that search.</p>
          ) : (
            <div className="history__list">
              {visibleSessions.map((one) => (
          <RunRow
                  key={one.sessionId}
                  session={one}
                  now={now}
                  open={one.sessionId === openSessionId}
                  api={api}
                  refresh={sessions.refresh}
            replaceSession={sessions.replaceSession}
            {...(prStates[one.sessionId] === undefined ? {} : { prState: prStates[one.sessionId] })}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <a
        className="rail__settings"
        href={ROUTE_PATHS.settings}
        onClick={(event): void => {
          navigateFromRail(event, ROUTE_PATHS.settings);
        }}
      >
        <span className="rail__gear" aria-hidden="true">
          &#9881;
        </span>
        Settings
      </a>
    </aside>
  );
}
