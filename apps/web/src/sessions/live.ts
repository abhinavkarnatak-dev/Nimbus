import type {
  ApprovalRequest,
  CheckResult,
  FileChange,
  PullRequestResult,
  ServerEvent,
  SessionDetail,
  SessionFailure,
  SessionMessage,
  SessionProgress,
  SessionStatus,
  RunStatus,
  DeliveryStatus,
  ToolName,
  ToolOutcome,
} from '@nimbus/contracts';

import { terminalLines, type BoundedOutput } from '../render/safe.js';

export const OUTPUT_KEPT_CHARS = 200_000;

export interface ToolRun {
  toolCallId: string;
  tool: ToolName | null;
  summary: string;
  paths: readonly string[];
  startedAt: string;
  outcome: ToolOutcome | null;
  durationMs: number | null;
  output: string;
  truncated: boolean;
}

export interface LiveSession {
  status: SessionStatus;
  runStatus: RunStatus | null;
  deliveryStatus: DeliveryStatus | null;
  progress: SessionProgress;
  messages: readonly SessionMessage[];
  question: { question: string; expiresAt: string } | null;
  approval: ApprovalRequest | null;
  failure: SessionFailure | null;
  pullRequest: PullRequestResult | null;
  files: readonly FileChange[];
  checks: readonly CheckResult[];
  tools: readonly ToolRun[];
}

export function liveFrom(detail: SessionDetail): LiveSession {
  return {
    status: detail.status,
    runStatus: detail.runStatus,
    deliveryStatus: detail.deliveryStatus,
    progress: detail.progress,
    messages: detail.messages,
    question: null,
    approval: null,
    failure: detail.failure,
    pullRequest: detail.pullRequest,
    files: detail.filesChanged,
    checks: detail.checks,
    tools: [],
  };
}

function withTool(
  tools: readonly ToolRun[],
  toolCallId: string,
  change: (one: ToolRun) => ToolRun,
  make: () => ToolRun,
): readonly ToolRun[] {
  const held = tools.find((one) => one.toolCallId === toolCallId);

  if (held === undefined) {
    return [...tools, change(make())];
  }

  return tools.map((one) => (one.toolCallId === toolCallId ? change(one) : one));
}

function blankTool(toolCallId: string): ToolRun {
  return {
    toolCallId,
    tool: null,
    summary: '',
    paths: [],
    startedAt: new Date().toISOString(),
    outcome: null,
    durationMs: null,
    output: '',
    truncated: false,
  };
}

export function applyEvent(live: LiveSession, event: ServerEvent): LiveSession {
  switch (event.type) {
    case 'session.status':
      return {
        ...live,
        status: event.status,
        progress: event.progress,
        question: null,
        approval: null,
      };

    case 'agent.message':
      return {
        ...live,
        messages: live.messages.some((one) => one.messageId === event.message.messageId)
          ? live.messages.map((one) =>
              one.messageId === event.message.messageId ? event.message : one,
            )
          : [...live.messages, event.message],
      };

    case 'agent.message.delta': {
      const held = live.messages.find((one) => one.messageId === event.messageId);
      const next = {
        messageId: event.messageId,
        role: 'agent' as const,
        text: `${held?.text ?? ''}${event.text}`,
        sentAt: event.sentAt,
      };
      return {
        ...live,
        messages:
          held === undefined
            ? [...live.messages, next]
            : live.messages.map((one) => (one.messageId === event.messageId ? next : one)),
      };
    }

    case 'agent.question':
      return {
        ...live,
        status: 'awaiting_user',
        messages: [
          ...live.messages,
          {
            messageId:
              `msg_question_${event.expiresAt.replace(/[^0-9]/g, '').slice(-14)}` as SessionMessage['messageId'],
            role: 'agent',
            text: event.question,
            sentAt: new Date().toISOString(),
          },
        ],
        question: { question: event.question, expiresAt: event.expiresAt },
      };

    case 'agent.approval_required':
      return { ...live, status: 'awaiting_user', approval: event.approval };

    case 'tool.started':
      return {
        ...live,
        tools: withTool(
          live.tools,
          event.invocation.toolCallId,
          (one) => ({
            ...one,
            tool: event.invocation.tool,
            summary: event.invocation.summary,
            paths: event.invocation.paths,
            startedAt: event.invocation.startedAt,
          }),
          () => blankTool(event.invocation.toolCallId),
        ),
      };

    case 'tool.output':
      return {
        ...live,
        tools: withTool(
          live.tools,
          event.toolCallId,
          (one) => ({
            ...one,
            output: `${one.output}${event.chunk}`.slice(-OUTPUT_KEPT_CHARS),
            truncated: one.truncated || event.truncated,
          }),
          () => blankTool(event.toolCallId),
        ),
      };

    case 'tool.completed':
      return {
        ...live,
        tools: withTool(
          live.tools,
          event.toolCallId,
          (one) => ({
            ...one,
            tool: event.tool,
            outcome: event.outcome,
            durationMs: event.durationMs,
            summary: event.summary === '' ? one.summary : event.summary,
          }),
          () => blankTool(event.toolCallId),
        ),
      };

    case 'files.changed':
      return { ...live, files: event.files };

    case 'checks.updated':
      return { ...live, checks: event.checks };

    case 'pr.created':
      return { ...live, pullRequest: event.pullRequest, status: 'pr_created' };

    case 'session.failed':
      return { ...live, failure: event.failure, status: 'failed', approval: null, question: null };

    case 'session.cancelled':
      return { ...live, status: 'cancelled', approval: null, question: null };
  }
}

export function applyEvents(live: LiveSession, events: readonly ServerEvent[]): LiveSession {
  return events.reduce(applyEvent, live);
}

export function outputLines(one: ToolRun): BoundedOutput {
  return terminalLines(one.output);
}

export function answered(live: LiveSession): LiveSession {
  return { ...live, question: null };
}

export function decided(live: LiveSession): LiveSession {
  return { ...live, approval: null };
}
