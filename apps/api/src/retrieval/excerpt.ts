import { clipLine } from '../agent/tools/text.js';
import { REDACTED, redactSecrets } from '../logging/redact.js';
import { RETRIEVAL_LIMITS } from './limits.js';

const KEY_BLOCK_START = /-----BEGIN[^-]*PRIVATE KEY-----/;
const KEY_BLOCK_END = /-----END[^-]*PRIVATE KEY-----/;

export interface ExcerptWindow {
  startLine: number;
  endLine: number;
  text: string;
}

interface Span {
  start: number;
  end: number;
  matches: number;
}

export function redactWindowLines(lines: readonly string[]): string[] {
  const output: string[] = [];
  let insideKeyBlock = false;

  for (const line of lines) {
    if (insideKeyBlock) {
      output.push(REDACTED);
      insideKeyBlock = !KEY_BLOCK_END.test(line);
      continue;
    }

    if (KEY_BLOCK_START.test(line)) {
      output.push(REDACTED);
      insideKeyBlock = !KEY_BLOCK_END.test(line);
      continue;
    }
    output.push(redactSecrets(line));
  }
  return output;
}

export function mergeSpans(lines: readonly number[], total: number): Span[] {
  const context = RETRIEVAL_LIMITS.excerptContextLines;
  const spans: Span[] = [];

  for (const line of [...lines].sort((left, right) => left - right)) {
    const start = Math.max(1, line - context);
    const end = Math.min(total, line + context);
    const last = spans[spans.length - 1];

    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      last.matches += 1;
      continue;
    }
    spans.push({ start, end, matches: 1 });
  }
  return spans;
}

function renderSpan(lines: readonly string[], span: Span): ExcerptWindow {
  const chosen: string[] = [];

  for (let number = span.start; number <= span.end; number += 1) {
    chosen.push(lines[number - 1] ?? '');
  }

  const safe = redactWindowLines(chosen).map(
    (line) => clipLine(line, RETRIEVAL_LIMITS.excerptMaxLineChars).text,
  );

  return { startLine: span.start, endLine: span.end, text: safe.join('\n') };
}

export function buildExcerpt(contents: string, matchedLines: readonly number[]): ExcerptWindow[] {
  const lines = contents.split('\n');
  const total = lines.length;

  if (total === 0) {
    return [];
  }

  if (matchedLines.length === 0) {
    const end = Math.min(total, RETRIEVAL_LIMITS.excerptMaxLines);
    return [renderSpan(lines, { start: 1, end, matches: 0 })];
  }

  const spans = mergeSpans(matchedLines, total);
  const ordered = [...spans].sort((left, right) => {
    if (left.matches !== right.matches) {
      return right.matches - left.matches;
    }
    return left.start - right.start;
  });

  const kept: Span[] = [];
  let budget: number = RETRIEVAL_LIMITS.excerptMaxLines;

  for (const span of ordered) {
    if (kept.length >= RETRIEVAL_LIMITS.excerptMaxWindows || budget <= 0) {
      break;
    }

    const height = span.end - span.start + 1;
    const end = height > budget ? span.start + budget - 1 : span.end;

    kept.push({ start: span.start, end, matches: span.matches });
    budget -= end - span.start + 1;
  }

  return kept
    .sort((left, right) => left.start - right.start)
    .map((span) => renderSpan(lines, span));
}
