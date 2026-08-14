import {
  ToolInvocationSchema,
  type ToolInvocation,
  type ToolName,
  type ToolOutcome,
} from '@nimbus/contracts';

import type { Logger } from '../../logging/logger.js';
import type { CommandRunner } from '../commands/runner.js';
import type { Sandbox } from '../../sandbox/index.js';
import {
  describeForModel,
  nameLooksForbidden,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
} from './definition.js';
import { REGISTRY_LIMITS } from './limits.js';
import { RegistryError, alreadyAborted, codeFor, isAbortError, outcomeFor } from './outcomes.js';
import { BUILT_IN_TOOLS } from './tools.js';

export interface InvokeRequest {
  toolCallId: string;
  tool: string;
  input: unknown;
  signal?: AbortSignal;
}

export interface InvokeResult {
  invocation: ToolInvocation;
  outcome: ToolOutcome;
  durationMs: number;
  output: ToolOutput | null;
  errorCode: string | null;
  message: string | null;
}

export interface RegistryOptions {
  sessionId: string;
  sandbox: Sandbox;
  commands: CommandRunner;
  logger: Logger;
  tools?: readonly ToolDefinition[];
  now?: () => Date;
}

export class ToolRegistry {
  private readonly tools = new Map<ToolName, ToolDefinition>();

  private readonly sessionId: string;

  private readonly sandbox: Sandbox;

  private readonly commands: CommandRunner;

  private readonly logger: Logger;

  private readonly now: () => Date;

  constructor(options: RegistryOptions) {
    this.sessionId = options.sessionId;
    this.sandbox = options.sandbox;
    this.commands = options.commands;
    this.logger = options.logger;
    this.now = options.now ?? ((): Date => new Date());

    for (const tool of options.tools ?? BUILT_IN_TOOLS) {
      this.register(tool);
    }
  }

  register(tool: ToolDefinition): void {
    const forbidden = nameLooksForbidden(tool.name);

    if (forbidden !== null) {
      throw new RegistryError('TOOL_FORBIDDEN', 'That tool may never be offered to a model.', {
        detail: `${tool.name} looks like ${forbidden}`,
      });
    }

    if (this.tools.has(tool.name)) {
      throw new RegistryError('TOOL_FORBIDDEN', 'That tool is already registered.', {
        detail: tool.name,
      });
    }

    if (tool.description.length > REGISTRY_LIMITS.descriptionMaxChars) {
      throw new RegistryError('TOOL_INPUT_INVALID', 'That tool description is too long.', {
        detail: tool.name,
      });
    }
    this.tools.set(tool.name, tool);
  }

  names(): ToolName[] {
    return [...this.tools.keys()].sort();
  }

  has(name: string): boolean {
    return this.tools.has(name as ToolName);
  }

  check(name: string, input: unknown): { ok: true } | { ok: false; detail: string } {
    const tool = this.tools.get(name as ToolName);

    if (tool === undefined) {
      return { ok: false, detail: `there is no tool called ${name}` };
    }

    const parsed = tool.parse(input);
    return parsed.ok ? { ok: true } : { ok: false, detail: parsed.detail };
  }

  describe(): ReturnType<typeof describeForModel>[] {
    return [...this.tools.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => describeForModel(tool));
  }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    const startedAt = this.now();
    const started = Date.now();

    if (alreadyAborted(request.signal)) {
      return this.finish(request, startedAt, started, null, {
        error: new RegistryError('TOOL_CANCELLED', 'That work was cancelled before it began.'),
      });
    }

    const tool = this.tools.get(request.tool as ToolName);

    if (tool === undefined) {
      return this.finish(request, startedAt, started, null, {
        error: new RegistryError('TOOL_UNKNOWN', 'There is no such tool.', {
          detail: request.tool,
        }),
      });
    }

    const parsed = tool.parse(request.input);

    if (!parsed.ok) {
      return this.finish(request, startedAt, started, null, {
        error: new RegistryError('TOOL_INPUT_INVALID', 'Those arguments are not usable.', {
          detail: parsed.detail,
        }),
      });
    }

    const timeout = AbortSignal.timeout(tool.timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

    try {
      const output = await tool.run(parsed.value, this.contextWith(signal));
      return this.finish(request, startedAt, started, output, {});
    } catch (error) {
      if (alreadyAborted(request.signal)) {
        return this.finish(request, startedAt, started, null, {
          error: new RegistryError('TOOL_CANCELLED', 'That work was cancelled.', { cause: error }),
        });
      }

      if (timeout.aborted || isAbortError(error)) {
        return this.finish(request, startedAt, started, null, {
          error: new RegistryError('TOOL_TIMED_OUT', 'That tool took too long.', { cause: error }),
        });
      }
      return this.finish(request, startedAt, started, null, { error });
    }
  }

  private contextWith(signal: AbortSignal): ToolContext {
    return {
      sessionId: this.sessionId,
      sandbox: this.sandbox,
      commands: this.commands,
      signal,
    };
  }

  private finish(
    request: InvokeRequest,
    startedAt: Date,
    started: number,
    output: ToolOutput | null,
    failure: { error?: unknown },
  ): InvokeResult {
    const outcome: ToolOutcome =
      failure.error === undefined ? (output?.outcome ?? 'succeeded') : outcomeFor(failure.error);

    const invocation = ToolInvocationSchema.parse({
      toolCallId: request.toolCallId,
      tool: this.has(request.tool) ? request.tool : 'message_user',
      summary: (output?.summary ?? describeFailure(failure.error)).slice(
        0,
        REGISTRY_LIMITS.summaryMaxChars,
      ),
      paths: (output?.paths ?? []).slice(0, REGISTRY_LIMITS.pathsPerRecordMax),
      startedAt: startedAt.toISOString(),
    });

    const durationMs = Date.now() - started;

    this.logger.debug(
      {
        sessionId: this.sessionId,
        tool: request.tool,
        outcome,
        durationMs,
        code: failure.error === undefined ? null : codeFor(failure.error),
      },
      'a tool was invoked',
    );

    return {
      invocation,
      outcome,
      durationMs,
      output,
      errorCode: failure.error === undefined ? null : codeFor(failure.error),
      message: failure.error === undefined ? null : describeFailure(failure.error),
    };
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  return 'that tool did not finish';
}
