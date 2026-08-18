import type { CheckStatus, ToolName, ToolOutcome } from '@nimbus/contracts';

import type { LiveSession, ToolRun } from './live.js';

export const SESSION_TABS = ['progress', 'changes', 'checks', 'shell', 'pull_request'] as const;

export type SessionTab = (typeof SESSION_TABS)[number];

export const TAB_WORDS: Readonly<Record<SessionTab, string>> = {
  progress: 'Progress',
  changes: 'Changes',
  checks: 'Checks',
  shell: 'Shell',
  pull_request: 'Pull request',
};

export const TOOL_WORDS: Readonly<Record<ToolName, string>> = {
  list_tree: 'listed files',
  search_code: 'searched the code',
  semantic_search: 'searched by meaning',
  read_file: 'read a file',
  apply_patch: 'edited a file',
  create_file: 'created a file',
  run_command: 'ran a command',
  run_checks: 'ran the checks',
  git_status: 'checked what changed',
  prepare_commit: 'packaged the changes',
  message_user: 'sent you a note',
  finish_task: 'finished the task',
  wait_for_user: 'waited for you',
};

export const OUTCOME_WORDS: Readonly<Record<ToolOutcome, string>> = {
  succeeded: 'done',
  failed: 'failed',
  denied: 'refused',
  timed_out: 'timed out',
  cancelled: 'cancelled',
};

export const CHECK_WORDS: Readonly<Record<CheckStatus, string>> = {
  passed: 'passed',
  failed: 'failed',
  errored: 'errored',
  not_run: 'not run',
};

export const SHELL_TOOLS: readonly ToolName[] = ['run_command', 'run_checks'];

export function toneOf(outcome: ToolOutcome | null): 'running' | 'good' | 'bad' | 'quiet' {
  if (outcome === null) {
    return 'running';
  }
  if (outcome === 'succeeded') {
    return 'good';
  }
  return outcome === 'cancelled' ? 'quiet' : 'bad';
}

export function checkTone(status: CheckStatus): 'good' | 'bad' | 'quiet' {
  if (status === 'passed') {
    return 'good';
  }
  return status === 'not_run' ? 'quiet' : 'bad';
}

export function toolWords(one: ToolRun): string {
  return one.tool === null ? 'working' : TOOL_WORDS[one.tool];
}

export function shellRuns(tools: readonly ToolRun[]): readonly ToolRun[] {
  return tools.filter((one) => one.tool !== null && SHELL_TOOLS.includes(one.tool));
}

export function tabCount(tab: SessionTab, live: LiveSession): number | null {
  if (tab === 'progress') {
    return live.tools.length === 0 ? null : live.tools.length;
  }
  if (tab === 'changes') {
    return live.files.length === 0 ? null : live.files.length;
  }
  if (tab === 'checks') {
    return live.checks.length === 0 ? null : live.checks.length;
  }
  if (tab === 'shell') {
    const ran = shellRuns(live.tools).length;
    return ran === 0 ? null : ran;
  }
  return live.pullRequest === null ? null : 1;
}

export function tookWords(durationMs: number | null): string {
  if (durationMs === null) {
    return '';
  }
  if (durationMs < 1_000) {
    return `${String(durationMs)}ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)}s`;
}
