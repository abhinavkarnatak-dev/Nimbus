import type { ModelPlan, ModelRole } from '@nimbus/contracts';

import { LlmError } from '../llm/errors.js';
import {
  DEFAULT_LIGHT_MODEL,
  DEFAULT_REASONING_MODEL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  findModel,
  KNOWN_MODELS,
} from '../llm/models.js';

export const SELECTABLE_TEXT_MODELS: readonly string[] = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
];

export function selectableModels(): { id: string; provider: string; vision: boolean }[] {
  return KNOWN_MODELS.filter((model) => SELECTABLE_TEXT_MODELS.includes(model.id)).map((model) => ({
    id: model.id,
    provider: model.provider,
    vision: model.vision,
  }));
}

export function isSelectable(id: string): boolean {
  return SELECTABLE_TEXT_MODELS.includes(id) && findModel(id) !== null;
}

export function assertSelectableModel(id: string): string {
  const trimmed = id.trim();

  if (trimmed === '') {
    throw new LlmError('LLM_MODEL_UNKNOWN', 'No model was named.');
  }

  if (findModel(trimmed) === null) {
    throw new LlmError('LLM_MODEL_UNKNOWN', 'That model is not one Nimbus knows about.', {
      detail: trimmed,
    });
  }

  if (!SELECTABLE_TEXT_MODELS.includes(trimmed)) {
    throw new LlmError('LLM_MODEL_UNKNOWN', 'That model cannot be chosen for a session.', {
      detail: trimmed,
    });
  }
  return trimmed;
}

export function planFor(selection?: { textModel?: string }): ModelPlan {
  const asked = selection?.textModel;
  const chosenByUser = asked !== undefined && asked.trim() !== '';

  return {
    primary: chosenByUser ? assertSelectableModel(asked) : DEFAULT_TEXT_MODEL,
    light: DEFAULT_LIGHT_MODEL,
    reasoning: DEFAULT_REASONING_MODEL,
    vision: DEFAULT_VISION_MODEL,
    chosenByUser,
  };
}

export function modelForRole(plan: ModelPlan, role: ModelRole): string {
  return plan[role];
}
