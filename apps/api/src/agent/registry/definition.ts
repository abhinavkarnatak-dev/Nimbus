import type { CheckResult, ToolName, ToolOutcome } from '@nimbus/contracts';
import { z, type ZodType } from 'zod';

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
}

export interface ToolOutput {
  summary: string;
  paths?: readonly string[];
  text?: string;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  pause?: 'clarification' | 'approval';
  check?: CheckResult;
  outcome?: ToolOutcome;
}

export interface ToolSpec<Schema extends ZodType> {
  name: ToolName;
  description: string;
  timeoutMs: number;
  input: Schema;
  run: (input: z.infer<Schema>, context: ToolContext) => Promise<ToolOutput>;
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; detail: string };

export interface ToolDefinition {
  name: ToolName;
  description: string;
  timeoutMs: number;
  parse: (value: unknown) => ParseResult;
  jsonSchema: () => Readonly<Record<string, unknown>>;
  run: (input: unknown, context: ToolContext) => Promise<ToolOutput>;
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
  };
}

export function describeForModel(tool: ToolDefinition): {
  name: ToolName;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
} {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.jsonSchema(),
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
