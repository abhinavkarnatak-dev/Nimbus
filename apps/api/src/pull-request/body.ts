import type { CheckResult, PatchValidationReport } from '@nimbus/contracts';

export const MIN_FENCE = 3;
export const MAX_LISTED_FILES = 30;
export const BACKTICK = String.fromCharCode(96);

export const AI_NOTICE = [
  'This pull request was written by Nimbus, an AI coding agent, from the task above.',
  'Nothing has been merged. Nimbus never merges, approves or closes a pull request, and never',
  'writes to the default branch. Please review every change before merging.',
].join(' ');

export interface PullRequestBodyInput {
  task: string;
  summary: string;
  branch: string;
  baseCommitSha: string;
  report: PatchValidationReport;
  checks: readonly CheckResult[];
}

export function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;

  for (const character of text) {
    if (character === BACKTICK) {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }
    current = 0;
  }

  return longest;
}

export function fenced(text: string): string {
  const body = text.trim() === '' ? '(nothing was given)' : text;
  const fence = BACKTICK.repeat(Math.max(MIN_FENCE, longestBacktickRun(body) + 1));

  return [fence, body, fence].join('\n');
}

export function failingChecks(checks: readonly CheckResult[]): CheckResult[] {
  return checks.filter((check) => check.status !== 'passed');
}

function checkLine(check: CheckResult): string {
  const mark =
    check.status === 'passed'
      ? 'passed'
      : check.status === 'not_run'
        ? 'did not run'
        : check.status;

  return `- ${check.kind}: ${mark}`;
}

function fileLine(file: PatchValidationReport['files'][number]): string {
  const moved = file.previousPath === undefined ? '' : ` (was ${file.previousPath})`;
  return `- ${file.changeKind} ${file.path}${moved} +${String(file.addedLines)} -${String(file.removedLines)}`;
}

export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const blocks: string[] = [];
  const failed = failingChecks(input.checks);

  if (failed.length > 0) {
    blocks.push('## Checks did not all pass');
    blocks.push(
      'Read this before reviewing. The following did not pass, so this change is not known to work.',
    );
    blocks.push(failed.map(checkLine).join('\n'));
  }

  blocks.push('## What was asked');
  blocks.push(fenced(input.task));

  blocks.push('## What Nimbus did');
  blocks.push(fenced(input.summary));

  blocks.push('## What changed');
  blocks.push(
    [
      `- branch: ${input.branch}`,
      `- based on: ${input.baseCommitSha}`,
      `- files: ${String(input.report.changedFiles)}`,
      `- lines: +${String(input.report.addedLines)} -${String(input.report.removedLines)}`,
    ].join('\n'),
  );

  if (input.report.files.length > 0) {
    const listed = input.report.files.slice(0, MAX_LISTED_FILES);
    const more = input.report.files.length - listed.length;
    const lines = listed.map(fileLine);

    if (more > 0) {
      lines.push(`- and ${String(more)} more`);
    }

    blocks.push(lines.join('\n'));
  }

  blocks.push('## Checks');
  blocks.push(
    input.checks.length === 0 ? '- none were run' : input.checks.map(checkLine).join('\n'),
  );

  blocks.push('## About this pull request');
  blocks.push(AI_NOTICE);

  return blocks.join('\n\n');
}
