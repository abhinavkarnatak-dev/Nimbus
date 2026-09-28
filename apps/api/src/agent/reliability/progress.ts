import type { AgentState, FailureClass, ProgressKind } from '@nimbus/contracts';

import type { ExecutionResult } from '../execute/executor.js';

export interface ProgressClassification {
  kind: ProgressKind;
  failure: FailureClass | null;
  producedProgress: boolean;
}

export function classifyProgress(state: AgentState, result: ExecutionResult): ProgressClassification {
  if (result.status === 'denied') {
    return { kind: 'none', failure: 'policy_denial', producedProgress: false };
  }
  if (result.status === 'refused') {
    return { kind: 'none', failure: 'invalid_arguments', producedProgress: false };
  }
  if (result.event.outcome === 'failed') {
    return { kind: 'diagnosed_failure', failure: 'permanent_failure', producedProgress: true };
  }
  if (result.event.tool === 'apply_patch' || result.event.tool === 'create_file') {
    return result.paths.length === 0
      ? { kind: 'none', failure: 'no_progress', producedProgress: false }
      : { kind: 'workspace_change', failure: null, producedProgress: true };
  }
  if (result.check !== null) {
    return { kind: 'new_check_result', failure: null, producedProgress: true };
  }
  if (result.event.tool === 'search_code' && /matches:\s*0\b/i.test(result.observation.summary)) {
    return { kind: 'none', failure: 'no_results', producedProgress: false };
  }
  if (result.event.tool === 'read_file') {
    const alreadyRead = result.paths.every((path) => state.filesRead.includes(path));
    return alreadyRead
      ? { kind: 'none', failure: 'no_progress', producedProgress: false }
      : { kind: 'new_content', failure: null, producedProgress: true };
  }
  if (result.paths.some((path) => !state.filesRead.includes(path))) {
    return { kind: 'new_path', failure: null, producedProgress: true };
  }
  if (result.pause === 'approval') return { kind: 'none', failure: null, producedProgress: false };
  return { kind: 'none', failure: 'no_progress', producedProgress: false };
}

export function recoveryFor(failure: FailureClass): 'retry' | 'reconcile' | 'replan' | 'stop' {
  if (failure === 'transient_failure' || failure === 'timeout') return 'retry';
  if (failure === 'unknown_outcome') return 'reconcile';
  if (failure === 'no_results' || failure === 'no_progress' || failure === 'stale_input') return 'replan';
  return 'stop';
}
