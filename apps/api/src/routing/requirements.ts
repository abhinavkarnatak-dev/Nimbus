import type { LlmProviderName, ModelRole } from '@nimbus/contracts';

import {
  DEFAULT_LIGHT_MODEL,
  DEFAULT_REASONING_MODEL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  findModel,
} from '../llm/models.js';
import { SELECTABLE_TEXT_MODELS } from './selection.js';

export interface ModelDefaults {
  defaultTextModel?: string;
  defaultVisionModel?: string;
}

export interface PlannedModel {
  role: ModelRole;
  setting: string;
  model: string;
  chosenBy: 'configuration' | 'server' | 'user';
}

function named(configured: string | undefined, fallback: string): string {
  return configured === undefined || configured.trim() === '' ? fallback : configured.trim();
}

export function plannedModels(defaults: ModelDefaults): PlannedModel[] {
  const primary = named(defaults.defaultTextModel, DEFAULT_TEXT_MODEL);
  const vision = named(defaults.defaultVisionModel, DEFAULT_VISION_MODEL);

  const planned: PlannedModel[] = [
    { role: 'primary', setting: 'DEFAULT_TEXT_MODEL', model: primary, chosenBy: 'configuration' },
    { role: 'light', setting: 'the light role', model: DEFAULT_LIGHT_MODEL, chosenBy: 'server' },
    {
      role: 'reasoning',
      setting: 'the reasoning role',
      model: DEFAULT_REASONING_MODEL,
      chosenBy: 'server',
    },
    { role: 'vision', setting: 'DEFAULT_VISION_MODEL', model: vision, chosenBy: 'configuration' },
  ];

  for (const model of SELECTABLE_TEXT_MODELS) {
    if (planned.some((one) => one.role === 'primary' && one.model === model)) {
      continue;
    }
    planned.push({
      role: 'primary',
      setting: 'the selectable model catalogue',
      model,
      chosenBy: 'user',
    });
  }

  return planned;
}

export function providersForPlan(defaults: ModelDefaults): LlmProviderName[] {
  const providers = new Set<LlmProviderName>();

  for (const planned of plannedModels(defaults)) {
    const facts = findModel(planned.model);

    if (facts !== null) {
      providers.add(facts.provider);
    }
  }

  return [...providers].sort((a, b) => a.localeCompare(b));
}

function issueFor(planned: PlannedModel, reason: string): string {
  return `${planned.setting}: ${reason} (${planned.role} role, ${planned.model})`;
}

export function modelCatalogueIssues(defaults: ModelDefaults): string[] {
  const issues: string[] = [];

  for (const planned of plannedModels(defaults)) {
    const facts = findModel(planned.model);

    if (facts === null) {
      issues.push(issueFor(planned, 'names a model Nimbus does not know about'));
      continue;
    }

    if (planned.role === 'vision' && !facts.vision) {
      issues.push(issueFor(planned, 'names a model that cannot look at images'));
      continue;
    }

    if (planned.role !== 'vision' && facts.structuredOutput !== 'json_schema') {
      issues.push(issueFor(planned, 'names a model that cannot hold a schema'));
    }
  }

  return issues.sort((a, b) => a.localeCompare(b));
}
