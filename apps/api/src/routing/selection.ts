import {
  LLM_PROVIDERS,
  ModelCatalogueResponseSchema,
  SelectableModelSchema,
  type LlmProviderName,
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

export const SELECTABLE_TEXT_MODELS: readonly string[] = KNOWN_MODELS.filter(
  (model) => model.selectable,
).map((model) => model.id);

export const ROLE_CANDIDATES: Readonly<Record<ModelRole, readonly string[]>> = {
  primary: [DEFAULT_TEXT_MODEL, DEFAULT_LIGHT_MODEL],
  light: [DEFAULT_LIGHT_MODEL, DEFAULT_TEXT_MODEL],
  reasoning: [DEFAULT_REASONING_MODEL, DEFAULT_TEXT_MODEL],
  vision: [DEFAULT_VISION_MODEL],
};

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

  get empty(): boolean {
    return this.#models.length === 0;
  }

  response(): ModelCatalogueResponse {
    return ModelCatalogueResponseSchema.parse({ models: this.#models });
  }

  assertAvailable(id: string): string {
    const selected = assertSelectableModel(id);

    if (!this.#models.some((model) => model.id === selected)) {
      throw new LlmError(
        'LLM_MODEL_UNKNOWN',
        'That model needs an API key this account has not added.',
        { detail: selected },
      );
    }
    return selected;
  }
}

export function catalogueFor(providers: readonly LlmProviderName[]): SelectableModelCatalogue {
  const held = new Set(providers);
  return new SelectableModelCatalogue(
    selectableModels().filter((model) => held.has(model.provider)),
  );
}

export interface PlanSelection {
  textModel?: string;
  providers?: readonly LlmProviderName[];
}

function servedBy(model: string, providers: readonly LlmProviderName[]): boolean {
  const facts = findModel(model);
  return facts !== null && providers.includes(facts.provider);
}

function modelForCandidates(role: ModelRole, providers: readonly LlmProviderName[]): string {
  const served = ROLE_CANDIDATES[role].find((model) => servedBy(model, providers));

  if (served === undefined) {
    throw new LlmError(
      'LLM_NOT_CONFIGURED',
      'No model Nimbus can use for this run is covered by the API keys on this account.',
      { detail: role },
    );
  }
  return served;
}

export function planFor(selection?: PlanSelection): ModelPlan {
  const providers = selection?.providers ?? LLM_PROVIDERS;
  const asked = selection?.textModel;
  const chosenByUser = asked !== undefined && asked.trim() !== '';

  const primary = chosenByUser
    ? assertSelectableModel(asked)
    : modelForCandidates('primary', providers);

  if (!servedBy(primary, providers)) {
    throw new LlmError(
      'LLM_NOT_CONFIGURED',
      'That model needs an API key this account has not added.',
      { detail: primary },
    );
  }

  return {
    primary,
    light: modelForCandidates('light', providers),
    reasoning: modelForCandidates('reasoning', providers),
    vision: DEFAULT_VISION_MODEL,
    chosenByUser,
  };
}

export function modelForRole(plan: ModelPlan, role: ModelRole): string {
  return plan[role];
}
