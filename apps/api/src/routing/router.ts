import type { BudgetState, CallReport, ModelPlan, ModelRole } from '@nimbus/contracts';

import { SessionBudget, type BudgetLimits } from '../llm/budget.js';
import type {
  CompleteRequest,
  CompleteResult,
  StructuredRequest,
  StructuredResult,
  TextProvider,
} from '../llm/provider.js';
import type { Logger } from '../logging/logger.js';
import { planFor, modelForRole } from './selection.js';

export interface SessionRouterOptions {
  text: TextProvider;
  logger: Logger;
  selection?: { textModel?: string };
  budget?: SessionBudget;
  budgetLimits?: Partial<BudgetLimits>;
}

export interface RoleRequest extends Omit<CompleteRequest, 'model'> {
  role?: ModelRole;
}

export interface RoleStructuredRequest<T> extends Omit<StructuredRequest<T>, 'model'> {
  role?: ModelRole;
}

export class SessionRouter {
  readonly plan: ModelPlan;

  private readonly text: TextProvider;

  private readonly logger: Logger;

  private readonly budget: SessionBudget;

  constructor(options: SessionRouterOptions) {
    this.plan = planFor(options.selection);
    this.text = options.text;
    this.logger = options.logger;
    this.budget = options.budget ?? new SessionBudget(options.budgetLimits ?? {});
  }

  modelFor(role: ModelRole = 'primary'): string {
    return modelForRole(this.plan, role);
  }

  budgetState(): BudgetState {
    return this.budget.state();
  }

  async complete(request: RoleRequest): Promise<CompleteResult> {
    const model = this.modelFor(request.role ?? 'primary');
    this.before(model, request.messages.length);

    const result = await this.text.complete({ ...withoutRole(request), model });
    this.after(model, result.report);
    return result;
  }

  async completeStructured<T>(request: RoleStructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.modelFor(request.role ?? 'primary');
    this.before(model, request.messages.length);

    const result = await this.text.completeStructured({ ...withoutRole(request), model });
    this.after(model, result.report);
    return result;
  }

  charge(report: CallReport): BudgetState {
    return this.budget.charge(report);
  }

  assertCanSpend(estimatedTokens = 0): void {
    this.budget.assertCanSpend(estimatedTokens);
  }

  private before(model: string, messages: number): void {
    this.budget.assertCanSpend();
    this.logger.debug({ model, messages }, 'routing a model call');
  }

  private after(model: string, report: CallReport): void {
    const state = this.budget.charge(report);

    this.logger.debug(
      {
        model,
        tokens: report.usage.totalTokens,
        microCents: report.cost.microCents,
        tokensUsed: state.tokensUsed,
        calls: state.calls,
      },
      'a model call was charged to the session',
    );
  }
}

function withoutRole<T extends { role?: ModelRole }>(request: T): Omit<T, 'role'> {
  const { role: _role, ...rest } = request;
  return rest;
}
