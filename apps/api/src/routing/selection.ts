import {
  ModelCatalogueResponseSchema,
  SelectableModelSchema,
  type ModelCatalogueResponse,
  type ModelPlan,
  type ModelRole,
  type SelectableModel,
} from '@nimbus/contracts';

import { LlmError } from '../llm/errors.js';
import {
  DEFAULT_LIGHT_MODEL,
  DEFAULT_REASONING_MODEL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  findModel,
  KNOWN_MODELS,
} from '../llm/models.js';
import type { LlmConfig } from '../config/load.js';

export const SELECTABLE_TEXT_MODELS: readonly string[] = KNOWN_MODELS.filter(
  (model) => model.selectable,
).map((model) => model.id);

export function selectableModels(): SelectableModel[] {
  return KNOWN_MODELS.filter((model) => model.selectable).map((model) =>
    SelectableModelSchema.parse({
      id: model.id,
      provider: model.provider,
      vision: model.vision,
      reasoning: model.thinks,
    }),
  );
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

export class SelectableModelCatalogue {
  readonly #models: readonly SelectableModel[];

  constructor(models: readonly SelectableModel[] = selectableModels()) {
    this.#models = ModelCatalogueResponseSchema.parse({ models }).models;
  }

  response(): ModelCatalogueResponse {
    return ModelCatalogueResponseSchema.parse({ models: this.#models });
  }

  assertAvailable(id: string): string {
    const selected = assertSelectableModel(id);

    if (!this.#models.some((model) => model.id === selected)) {
      throw new LlmError(
        'LLM_MODEL_UNKNOWN',
        'That model is not available for a new session on this server.',
        { detail: selected },
      );
    }
    return selected;
  }
}

export function modelCatalogueFor(config: LlmConfig): SelectableModelCatalogue {
  const configured = new Set<string>();

  if (config.geminiApiKey !== undefined) {
    configured.add('gemini');
  }
  if (config.groqApiKey !== undefined) {
    configured.add('groq');
  }

  const all = selectableModels();
  return new SelectableModelCatalogue(
    configured.size === 0 ? all : all.filter((model) => configured.has(model.provider)),
  );
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
