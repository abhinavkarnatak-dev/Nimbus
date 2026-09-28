import type { AgentState, ToolName } from '@nimbus/contracts';

import type { ToolDefinition } from '../registry/definition.js';
import { isCurrentDuplicate } from './semantic.js';

export interface EligibilityDecision {
  eligible: boolean;
  reason: string | null;
  reusableActionId: string | null;
}

function patchPaths(input: Record<string, unknown>): string[] {
  if (typeof input['path'] === 'string') return [input['path']];
  if (typeof input['patch'] !== 'string') return [];
  return [...input['patch'].matchAll(/^\+\+\+\s+(?:b\/)?([^\s]+)$/gm)]
    .map((match) => match[1] ?? '')
    .filter((one) => one !== '' && one !== '/dev/null');
}

function hasCurrentRead(state: AgentState, wanted: string): boolean {
  return state.evidence.some(
    (one) =>
      one.kind === 'file_content' &&
      one.current &&
      one.revision.treeHash === state.workspaceRevision.treeHash &&
      one.paths.includes(wanted),
  );
}

function packagingBlocker(state: AgentState): string | null {
  if (state.taskSpec.blockingAmbiguity !== null) return 'a blocking ambiguity is unresolved';
  if (state.taskSpec.acceptanceCriteria.some((one) => one.material && one.status !== 'satisfied')) {
    return 'material acceptance criteria are unresolved';
  }
  if (state.plan === null) return 'there is no current change plan';
  if (state.review?.verdict !== 'accepted') return 'independent review has not accepted the final revision';
  if (state.review.revision.treeHash !== state.workspaceRevision.treeHash) return 'review is stale';
  const required = state.checks.filter((check) => check.required === true);
  if (required.some((check) => check.revision?.treeHash !== state.workspaceRevision.treeHash)) {
    return 'a required check is stale';
  }
  if (required.some((check) => check.status !== 'passed' && check.status !== 'skipped')) {
    return 'a required check is unresolved';
  }
  return null;
}

export function toolEligibility(
  state: AgentState,
  tool: ToolDefinition,
  input?: Record<string, unknown>,
): EligibilityDecision {
  const refuse = (reason: string, reusableActionId: string | null = null): EligibilityDecision => ({
    eligible: false,
    reason,
    reusableActionId,
  });

  if (!tool.metadata.allowedPhases.includes(state.phase)) {
    return refuse(`${tool.name} is not allowed during ${state.phase}`);
  }
  if (state.taskSpec.mode === 'informational' && ['write', 'execute'].includes(tool.metadata.risk)) {
    return refuse('informational tasks cannot change or execute repository code');
  }
  if (state.phaseBudget.toolCalls >= state.phaseBudget.maxToolCalls) {
    return refuse('the tool-call budget for this phase is exhausted');
  }
  if (state.phaseBudget.noProgressActions >= state.phaseBudget.maxNoProgressActions) {
    return refuse('the no-progress budget for this phase is exhausted');
  }
  if (input !== undefined && isCurrentDuplicate(state, tool.name, input)) {
    const held = state.actions.find(
      (action) => action.tool === tool.name && action.revision.treeHash === state.workspaceRevision.treeHash,
    );
    return refuse('an equivalent action already ran on this workspace revision', held?.actionId ?? null);
  }
  if (input !== undefined && tool.metadata.precondition !== undefined) {
    const problem = tool.metadata.precondition(state, input);
    if (problem !== null) return refuse(problem);
  }
  if (input !== undefined && tool.name === 'apply_patch') {
    const stale = patchPaths(input).find((path) => !hasCurrentRead(state, path));
    if (stale !== undefined) return refuse(`${stale} has not been read at the current workspace revision`);
  }
  if (tool.name === 'run_checks' && state.filesChanged.length === 0) {
    return refuse('checks require a relevant workspace change');
  }
  if (tool.name === 'prepare_commit') {
    const blocker = packagingBlocker(state);
    if (blocker !== null) return refuse(blocker);
  }
  return { eligible: true, reason: null, reusableActionId: null };
}

export function eligibleTools(state: AgentState, tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => toolEligibility(state, tool).eligible);
}

export function toolNameEligible(
  state: AgentState,
  tools: readonly ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
): EligibilityDecision {
  const tool = tools.find((one) => one.name === (name as ToolName));
  return tool === undefined
    ? { eligible: false, reason: `there is no tool called ${name}`, reusableActionId: null }
    : toolEligibility(state, tool, input);
}
