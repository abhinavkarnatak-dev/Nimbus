import type { ToolName } from '@nimbus/contracts';

import { stripEscapes } from '../render/safe.js';
import { outputLines, type ToolRun } from './live.js';
import { OUTCOME_WORDS, toolWords, toneOf, tookWords } from './tabs.js';

interface MessageContentProps {
  text: string;
}

interface TextBlock {
  kind: 'text';
  text: string;
}

interface CodeBlock {
  kind: 'code';
  language: string;
  text: string;
}

type MessageBlock = TextBlock | CodeBlock;

export function messageBlocks(text: string): MessageBlock[] {
  const safe = stripEscapes(text);
  const blocks: MessageBlock[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  let cursor = 0;

  for (const match of safe.matchAll(fence)) {
    const index = match.index;
    if (index > cursor) blocks.push({ kind: 'text', text: safe.slice(cursor, index) });
    blocks.push({
      kind: 'code',
      language: (match[1] ?? '').trim(),
      text: (match[2] ?? '').replace(/\n$/, ''),
    });
    cursor = index + match[0].length;
  }

  if (cursor < safe.length) blocks.push({ kind: 'text', text: safe.slice(cursor) });
  return blocks.length === 0 ? [{ kind: 'text', text: safe }] : blocks;
}

function InlineText({ text }: { text: string }): React.JSX.Element {
  const pieces = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {pieces.map((piece, index) =>
        piece.startsWith('`') && piece.endsWith('`') ? (
          <code key={index}>{piece.slice(1, -1)}</code>
        ) : (
          piece
        ),
      )}
    </>
  );
}

export function MessageContent({ text }: MessageContentProps): React.JSX.Element {
  return (
    <div className="turn__body">
      {messageBlocks(text).map((block, index) =>
        block.kind === 'code' ? (
          <div className="turn__code" key={index}>
            {block.language === '' ? null : <span>{block.language}</span>}
            <pre>
              <code>{block.text}</code>
            </pre>
          </div>
        ) : (
          <InlineText text={block.text} key={index} />
        ),
      )}
    </div>
  );
}

const CHAT_ACTIVITY_TOOLS: ReadonlySet<ToolName> = new Set([
  'list_tree',
  'search_code',
  'semantic_search',
  'read_file',
  'apply_patch',
  'create_file',
  'run_command',
  'run_checks',
  'git_status',
  'prepare_commit',
]);

function Activity({ run }: { run: ToolRun }): React.JSX.Element | null {
  if (run.tool === null || !CHAT_ACTIVITY_TOOLS.has(run.tool)) return null;

  const output = outputLines(run);
  const hasOutput = output.lines.some((line) => line !== '');
  const status = run.outcome === null ? 'running' : OUTCOME_WORDS[run.outcome];

  return (
    <article className="activity" data-tone={toneOf(run.outcome)}>
      <span className="activity__mark" aria-hidden="true" />
      <div className="activity__main">
        <div className="activity__head">
          <span className="activity__verb">{toolWords(run)}</span>
          <span className="activity__status">{status}</span>
          {run.durationMs === null ? null : <span>{tookWords(run.durationMs)}</span>}
        </div>
        <p className="activity__summary">{run.summary}</p>
        {run.resultSummary === '' ? null : <p className="activity__result">{run.resultSummary}</p>}
        {run.paths.length === 0 ? null : (
          <div className="activity__paths">
            {run.paths.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        )}
        {!hasOutput ? null : (
          <details className="activity__output" open={run.outcome === null}>
            <summary>{run.outcome === null ? 'Live output' : 'Output'}</summary>
            <pre>
              <code>{output.lines.join('\n')}</code>
            </pre>
            {run.truncated || output.truncated ? <p>Output was truncated.</p> : null}
          </details>
        )}
      </div>
    </article>
  );
}

export function ActivityFeed({ tools }: { tools: readonly ToolRun[] }): React.JSX.Element | null {
  const visible = tools.filter((run) => run.tool !== null && CHAT_ACTIVITY_TOOLS.has(run.tool));
  if (visible.length === 0) return null;

  return (
    <section className="activity-feed" aria-label="Agent activity">
      {visible.map((run) => (
        <Activity run={run} key={run.toolCallId} />
      ))}
    </section>
  );
}
