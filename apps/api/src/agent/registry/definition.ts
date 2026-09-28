import type { AgentPhase, AgentState, CheckResult, ToolName, ToolOutcome } from '@nimbus/contracts';
import { z, type ZodType } from 'zod';

import type { PatchCaps } from '../../config/limits.js';
import type { CommandRunner } from '../commands/runner.js';
import type { Sandbox } from '../../sandbox/index.js';

export const FORBIDDEN_TOOL_WORDS: readonly string[] = [
  'push',
  'pull_request',
  'pullrequest',
  'merge',
  'approve',
  'token',
  'secret',
  'credential',
  'fetch',
  'http',
  'network',
  'download',
  'upload',
];

export interface ToolContext {
  sessionId: string;
  sandbox: Sandbox;
  commands: CommandRunner;
  signal: AbortSignal;
  limits: PatchCaps;
  state?: AgentState;
}

export interface ToolOutput {
  summary: string;
  paths?: readonly string[];
  text?: string;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  complete?: boolean;
  pause?: 'clarification' | 'approval';
  check?: CheckResult;
  outcome?: ToolOutcome;
}

export type ToolRisk = 'read' | 'write' | 'execute' | 'terminal';

export interface ToolRetryRule {
  maxAttempts: number;
  retryable: readonly ('transient_failure' | 'timeout')[];
  reconcileUnknownWrite: boolean;
}

export interface ToolMetadata {
  allowedPhases: readonly AgentPhase[];
  risk: ToolRisk;
  expectedEffects: readonly string[];
  retry: ToolRetryRule;
  outputLimitChars: number;
  cost: 'low' | 'medium' | 'high';
  precondition?: (state: AgentState, input: unknown) => string | null;
}

export interface ToolSpec<Schema extends ZodType> {
  name: ToolName;
  description: string;
  timeoutMs: number;
  input: Schema;
  run: (input: z.infer<Schema>, context: ToolContext) => Promise<ToolOutput>;
  metadata?: Partial<ToolMetadata>;
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; detail: string };

export interface ToolDefinition {
  name: ToolName;
  description: string;
  timeoutMs: number;
  parse: (value: unknown) => ParseResult;
  jsonSchema: () => Readonly<Record<string, unknown>>;
  run: (input: unknown, context: ToolContext) => Promise<ToolOutput>;
  metadata: ToolMetadata;
}

const READ_PHASES: readonly AgentPhase[] = [
  'investigating',
  'planning',
  'implementing',
  'verifying',
  'reviewing',
];

function metadataFor(name: ToolName, supplied: Partial<ToolMetadata> = {}): ToolMetadata {
  const write = name === 'apply_patch' || name === 'create_file';
  const execute = name === 'run_command' || name === 'run_checks';
  const terminal = name === 'prepare_commit' || name === 'finish_task';
  const phases: readonly AgentPhase[] =
    name === 'apply_patch' || name === 'create_file'
      ? ['implementing']
      : name === 'run_checks'
        ? ['verifying']
        : name === 'prepare_commit'
          ? ['packaging']
          : name === 'finish_task'
            ? ['investigating', 'planning', 'implementing', 'reviewing', 'packaging']
            : name === 'wait_for_user'
              ? ['scoping', 'investigating', 'planning', 'implementing', 'verifying', 'reviewing']
              : READ_PHASES;

  return {
    allowedPhases: supplied.allowedPhases ?? phases,
    risk: supplied.risk ?? (terminal ? 'terminal' : write ? 'write' : execute ? 'execute' : 'read'),
    expectedEffects:
      supplied.expectedEffects ??
      (write
        ? ['workspace_change']
        : execute
          ? ['command_evidence']
          : terminal
            ? ['run_state_change']
            : ['repository_evidence']),
    retry: supplied.retry ?? {
      maxAttempts: write ? 1 : 2,
      retryable: write ? [] : ['transient_failure', 'timeout'],
      reconcileUnknownWrite: write,
    },
    outputLimitChars: supplied.outputLimitChars ?? 32_768,
    cost: supplied.cost ?? (execute || write ? 'high' : 'low'),
    ...(supplied.precondition === undefined ? {} : { precondition: supplied.precondition }),
  };
}

export function defineTool<Schema extends ZodType>(spec: ToolSpec<Schema>): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    timeoutMs: spec.timeoutMs,
    parse: (value: unknown): ParseResult => {
      const parsed = spec.input.safeParse(value);

      if (parsed.success) {
        return { ok: true, value: parsed.data };
      }

      return {
        ok: false,
        detail: parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.map(String).join('.') || 'root'}:${issue.code}`)
          .join(','),
      };
    },
    jsonSchema: (): Readonly<Record<string, unknown>> => z.toJSONSchema(spec.input),
    run: async (input: unknown, context: ToolContext): Promise<ToolOutput> =>
      await spec.run(input as z.infer<Schema>, context),
    metadata: metadataFor(spec.name, spec.metadata),
  };
}

export function describeForModel(tool: ToolDefinition): {
  name: ToolName;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
  metadata: Omit<ToolMetadata, 'precondition'>;
} {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.jsonSchema(),
    metadata: {
      allowedPhases: tool.metadata.allowedPhases,
      risk: tool.metadata.risk,
      expectedEffects: tool.metadata.expectedEffects,
      retry: tool.metadata.retry,
      outputLimitChars: tool.metadata.outputLimitChars,
      cost: tool.metadata.cost,
    },
  };
}

export function nameLooksForbidden(name: string): string | null {
  const normalized = name.toLowerCase().replace(/[^a-z_]/g, '');

  for (const word of FORBIDDEN_TOOL_WORDS) {
    if (normalized.includes(word)) {
      return word;
    }
  }
  return null;
}
