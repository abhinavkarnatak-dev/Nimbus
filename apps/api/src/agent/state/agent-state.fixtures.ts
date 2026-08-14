import type { AgentState, ModelPlan } from '@nimbus/contracts';

import { createState, type NewStateInput } from './state.js';

export const SESSION_ID = 'ses_agentstateagentstatea';
export const USER_ID = 'usr_agentstateagentstatea';
export const BASE_COMMIT = 'ae41b1ee22930cde5b5f9b9dc167324f4407286f';
export const OTHER_COMMIT = 'bf52c2ff33a41dedf6c6a0c0ed278435f5518397';

export const SAMPLE_PLAN: ModelPlan = {
  primary: 'gemini-3.6-flash',
  light: 'gemini-3.5-flash-lite',
  reasoning: 'openai/gpt-oss-120b',
  vision: 'gemini-3.6-flash',
  chosenByUser: false,
};

export const FIXED_START_MS = Date.now();

export function stateInput(overrides: Partial<NewStateInput> = {}): NewStateInput {
  return {
    budgets: { startedAtMs: FIXED_START_MS },
    sessionId: SESSION_ID,
    userId: USER_ID,
    repositoryId: 1_232_400_459,
    installationId: 152_879_739,
    task: 'the login redirect sends people to the wrong page',
    baseCommitSha: BASE_COMMIT,
    defaultBranch: 'main',
    models: SAMPLE_PLAN,
    ...overrides,
  };
}

export function sampleState(overrides: Partial<NewStateInput> = {}): AgentState {
  return createState(stateInput(overrides));
}

export const REAL_LOOKING_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
