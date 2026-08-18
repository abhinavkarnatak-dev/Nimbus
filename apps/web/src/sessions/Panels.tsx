import type { CheckResult, FileChange } from '@nimbus/contracts';
import { useState } from 'react';

import { safeHref } from '../render/safe.js';
import { barShare, changeWords, diffRows, fileName, folderName, totalLines } from './diff.js';
import { outputLines, type LiveSession, type ToolRun } from './live.js';
import {
  CHECK_WORDS,
  OUTCOME_WORDS,
  checkTone,
  shellRuns,
  toneOf,
  toolWords,
  tookWords,
} from './tabs.js';

function Nothing({ what, why }: { what: string; why: string }): React.JSX.Element {
  return (
    <div className="pane__none">
      <p className="pane__none-what">{what}</p>
      <p className="pane__none-why">{why}</p>
    </div>
  );
}

export function ProgressPane({ live }: { live: LiveSession }): React.JSX.Element {
  if (live.tools.length === 0) {
    return (
      <Nothing
        what="Nothing has run yet."
        why="Every file Nimbus reads and every command it runs shows up here as it happens."
      />
    );
  }

  return (
    <ol className="steps">
      {live.tools.map((one, at) => (
        <li className="step" key={one.toolCallId} data-tone={toneOf(one.outcome)}>
          <span className="step__mark" aria-hidden="true" />

          <div className="step__body">
            <p className="step__head">
              <span className="step__no">{String(at + 1)}</span>
              <span className="step__what">{toolWords(one)}</span>
              <span className="step__state">
                {one.outcome === null ? 'running' : OUTCOME_WORDS[one.outcome]}
                {one.durationMs === null ? '' : ` · ${tookWords(one.durationMs)}`}
              </span>
            </p>

            {one.summary === '' ? null : <p className="step__why">{one.summary}</p>}

            {one.paths.length === 0 ? null : (
              <p className="step__paths">
                {one.paths.map((path) => (
                  <span className="step__path" key={path}>
                    {path}
                  </span>
                ))}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function FileRow({
  file,
  open,
  onOpen,
}: {
  file: FileChange;
  open: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const share = barShare(file);
  const shown = open ? diffRows(file.diff, file.diffTruncated) : null;

  return (
    <li className="filed" data-open={open}>
      <button className="filed__head" type="button" onClick={onOpen} aria-expanded={open}>
        <span className="filed__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>

        <span className="filed__name">
          {folderName(file.path) === '' ? null : (
            <span className="filed__folder">{folderName(file.path)}/</span>
          )}
          {fileName(file.path)}
        </span>

        <span className="filed__kind" data-kind={file.changeKind}>
          {changeWords(file)}
        </span>

        <span className="filed__count">
          <span className="filed__plus">+{String(file.addedLines)}</span>
          <span className="filed__minus">-{String(file.removedLines)}</span>
        </span>

        <span className="filed__bar" aria-hidden="true">
          <span className="filed__bar-plus" style={{ width: `${String(share.added)}%` }} />
          <span className="filed__bar-minus" style={{ width: `${String(share.removed)}%` }} />
        </span>
      </button>

      {file.previousPath === undefined ? null : (
        <p className="filed__was">renamed from {file.previousPath}</p>
      )}

      {shown === null ? null : (
        <div className="hunks">
          {shown.rows.length === 0 ? (
            <p className="hunks__none">This file changed, and the diff was not kept.</p>
          ) : (
            <table className="hunks__table">
              <tbody>
                {shown.rows.map((row, at) => (
                  <tr className="hunks__row" data-kind={row.kind} key={`${String(at)}-${row.text}`}>
                    <td className="hunks__no">
                      {row.beforeLine === null ? '' : String(row.beforeLine)}
                    </td>
                    <td className="hunks__no">
                      {row.afterLine === null ? '' : String(row.afterLine)}
                    </td>
                    <td className="hunks__sign" aria-hidden="true">
                      {row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ''}
                    </td>
                    <td className="hunks__text">{row.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {shown.truncated ? (
            <p className="hunks__cut">
              This diff is longer than Nimbus shows here. The pull request has all of it.
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

export function ChangesPane({ live }: { live: LiveSession }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);

  if (live.files.length === 0) {
    return (
      <Nothing
        what="Nothing has changed yet."
        why="Once Nimbus edits a file it is listed here with what it added and removed."
      />
    );
  }

  const sum = totalLines(live.files);

  return (
    <>
      <p className="pane__word">
        {String(live.files.length)} {live.files.length === 1 ? 'file' : 'files'} changed
        <span className="filed__plus">+{String(sum.added)}</span>
        <span className="filed__minus">-{String(sum.removed)}</span>
      </p>

      <ul className="files">
        {live.files.map((one) => (
          <FileRow
            key={one.path}
            file={one}
            open={open === one.path}
            onOpen={(): void => {
              setOpen(open === one.path ? null : one.path);
            }}
          />
        ))}
      </ul>
    </>
  );
}

function CheckRow({ check }: { check: CheckResult }): React.JSX.Element {
  return (
    <li className="check" data-tone={checkTone(check.status)}>
      <span className="check__mark" aria-hidden="true" />

      <div className="check__body">
        <p className="check__head">
          <span className="check__name">{check.name}</span>
          <span className="check__kind">{check.kind}</span>
          <span className="check__state">
            {CHECK_WORDS[check.status]}
            {check.durationMs === undefined ? '' : ` · ${tookWords(check.durationMs)}`}
          </span>
        </p>

        {check.summary === '' ? null : <p className="check__why">{check.summary}</p>}
      </div>
    </li>
  );
}

export function ChecksPane({ live }: { live: LiveSession }): React.JSX.Element {
  if (live.checks.length === 0) {
    return (
      <Nothing
        what="No checks have run yet."
        why="Nimbus runs the repository's own tests, lint, typecheck and build before it pushes anything."
      />
    );
  }

  return (
    <ul className="checks">
      {live.checks.map((one) => (
        <CheckRow key={`${one.kind}-${one.name}`} check={one} />
      ))}
    </ul>
  );
}

function ShellRun({ run }: { run: ToolRun }): React.JSX.Element {
  const output = outputLines(run);

  return (
    <li className="shell" data-tone={toneOf(run.outcome)}>
      <p className="shell__head">
        <span className="shell__prompt" aria-hidden="true">
          $
        </span>
        <span className="shell__what">{run.summary === '' ? toolWords(run) : run.summary}</span>
        <span className="shell__state">
          {run.outcome === null ? 'running' : OUTCOME_WORDS[run.outcome]}
          {run.durationMs === null ? '' : ` · ${tookWords(run.durationMs)}`}
        </span>
      </p>

      {output.lines.length === 0 || run.output === '' ? (
        <p className="shell__quiet">No output.</p>
      ) : (
        <pre className="shell__out">
          {output.lines.map((line, at) => (
            <span className="shell__line" key={`${String(at)}-${line}`}>
              {line}
            </span>
          ))}
        </pre>
      )}

      {output.truncated || run.truncated ? (
        <p className="shell__cut">This output was longer than Nimbus keeps.</p>
      ) : null}
    </li>
  );
}

export function ShellPane({ live }: { live: LiveSession }): React.JSX.Element {
  const ran = shellRuns(live.tools);

  if (ran.length === 0) {
    return (
      <Nothing
        what="No commands have run yet."
        why="Every command Nimbus runs in the sandbox appears here with what it printed."
      />
    );
  }

  return (
    <ul className="shells">
      {ran.map((one) => (
        <ShellRun key={one.toolCallId} run={one} />
      ))}
    </ul>
  );
}

export type ManualPrState = 'open' | 'merged' | 'closed';

export function PullRequestPane({ live, states, onState }: { live: LiveSession; states: Record<number, ManualPrState>; onState: (number: number, state: ManualPrState) => void }): React.JSX.Element {
  const pr = live.pullRequest;
  const passedChecks = live.checks.filter((check) => check.status === 'passed').length;

  const numbers = [
    ...new Set(
      live.messages
        .filter((message) => message.role === 'agent')
        .flatMap((message) => [...message.text.matchAll(/\bPR #(\d+)\b/g)].map((match) => match[1]))
        .filter((number): number is string => number !== undefined),
    ),
  ];
  const pullRequests =
    pr === null
      ? []
      : numbers.length === 0
        ? [pr]
        : numbers.map((number) => ({
            ...pr,
            number: Number(number),
            url: pr.url.replace(/\/pull\/\d+(?:$|[?#])/, `/pull/${number}`),
          })).sort((left, right) => right.number - left.number);

  if (pr === null) {
    return (
      <Nothing
        what="No pull request yet."
        why="Nimbus opens one at the end, after the checks pass. It never merges and never pushes to your branch."
      />
    );
  }

  return (
    <div className="prs">
      {pullRequests.map((one) => {
        const url = safeHref(one.url);
        const current = one.number === pr.number;
        const state = states[one.number] ?? 'open';
        const delivery = live.messages.find((message) =>
          message.role === 'agent' && message.text.includes(`PR #${String(one.number)}`),
        )?.text;
        const lineMatch = delivery === undefined ? null : /\+(\d+)\s+−(\d+)\s+lines/.exec(delivery);
        return (
    <div className="pr" key={one.number} data-state={state}>
      <div className="pr__head">
        <p className="pr__eyebrow">{current ? 'Current pull request' : 'Pull request'} · {state}</p>
        <p className="pr__no">#{String(one.number)}</p>
      </div>

      <p className="pr__summary">
        Nimbus pushed from <code>{one.branch}</code> with <span className="pr__added">+{lineMatch?.[1] ?? '—'}</span> and{' '}<span className="pr__removed">−{lineMatch?.[2] ?? '—'}</span> lines.{' '}
        {passedChecks === 0
          ? 'No checks were recorded for this run.'
          : `${String(passedChecks)} ${passedChecks === 1 ? 'check' : 'checks'} passed before it was opened.`}
      </p>

      <dl className="facts">
        <div className="fact">
          <dt>Branch</dt>
          <dd>{one.branch}</dd>
        </div>

        <div className="fact">
          <dt>Commit</dt>
          <dd>{one.headSha.slice(0, 12)}</dd>
        </div>

        <div className="fact">
          <dt>Opened</dt>
          <dd>{new Date(one.createdAt).toLocaleString()}</dd>
        </div>
      </dl>

      {url === null ? null : (
        <a
          className="button button--primary pr__review"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Review it on GitHub
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3h7v7h-1.5V5.56L4.53 12.53l-1.06-1.06L10.44 4.5H6V3Z" />
          </svg>
        </a>
      )}

      <div className="pr__state-actions" aria-label={`Set pull request #${String(one.number)} status`}>
        <button
          className="pr__state"
          type="button"
          data-active={state === 'merged'}
          onClick={(): void => onState(one.number, 'merged')}
        >
          Mark merged
        </button>
        <button
          className="pr__state pr__state--closed"
          type="button"
          data-active={state === 'closed'}
          onClick={(): void => onState(one.number, 'closed')}
        >
          Mark closed
        </button>
      </div>

      <p className="pr__why">
        Nothing is merged. Reviewing, changing and merging all happen on GitHub, by you.
      </p>
    </div>
        );
      })}
    </div>
  );
}
