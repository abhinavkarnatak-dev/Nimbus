// @vitest-environment jsdom

import {
  CONTRACTS_WIRE_VERSION,
  MessageIdSchema,
  SessionDetailSchema,
  SessionIdSchema,
  type SessionDetailResponse,
  type SessionEventEnvelope,
  type SessionId,
} from '@nimbus/contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApiClient } from '../api/client.js';
import type { SocketLike } from '../events/socket.js';
import { useLiveSession, type LiveSessionHandle } from './useLiveSession.js';

const AT = '2026-09-28T10:00:00.000Z';
const FIRST = SessionIdSchema.parse('ses_aaaaaaaaaaaaaaaaaaaaa');
const SECOND = SessionIdSchema.parse('ses_bbbbbbbbbbbbbbbbbbbbb');
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

interface PendingRequest {
  path: string;
  resolve: (response: SessionDetailResponse) => void;
}

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];

  readonly sent: string[] = [];

  onopen: (() => void) | null = null;

  onmessage: ((event: { data: unknown }) => void) | null = null;

  onclose: ((event: { code: number }) => void) | null = null;

  onerror: (() => void) | null = null;

  constructor(_url: string | URL) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({ code: 1_000 });
  }

  event(envelope: SessionEventEnvelope): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
}

function detail(sessionId: SessionId, title: string): SessionDetailResponse {
  return {
    session: SessionDetailSchema.parse({
      sessionId,
      status: 'working',
      runStatus: 'working',
      deliveryStatus: null,
      manualPrStates: {},
      title,
      task: `Keep ${title} correctly scoped`,
      repository: {
        repositoryId: 42,
        owner: 'octocat',
        name: 'nimbus',
        defaultBranch: 'main',
        visibility: 'public',
        htmlUrl: 'https://github.com/octocat/nimbus',
        updatedAt: AT,
      },
      branch: null,
      pullRequest: null,
      createdAt: AT,
      lastActivityAt: AT,
      completedAt: null,
      model: { textModel: 'test-model' },
      baseCommitSha: null,
      attachments: [],
      messages: [],
      progress: { step: 1, maxSteps: 30, currentActivity: title },
      filesChanged: [],
      checks: [],
      approvals: [],
      failure: null,
    }),
    lastEventSequence: 0,
  };
}

function event(
  sessionId: SessionId,
  sequence: number,
  value: SessionEventEnvelope['event'],
): SessionEventEnvelope {
  return {
    v: CONTRACTS_WIRE_VERSION,
    sessionId,
    sequence,
    emittedAt: AT,
    event: value,
  };
}

function deferredApi(): { api: ApiClient; pending: PendingRequest[] } {
  const pending: PendingRequest[] = [];
  const api = {
    get: (path: string) =>
      new Promise<SessionDetailResponse>((resolve) => {
        pending.push({ path, resolve });
      }),
  } as unknown as ApiClient;
  return { api, pending };
}

describe('useLiveSession', () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let container: HTMLDivElement;
  let root: Root;
  let handle: LiveSessionHandle;

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeSocket as unknown as typeof globalThis.WebSocket;
    FakeSocket.instances = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    globalThis.WebSocket = originalWebSocket;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  function Harness({ sessionId, api }: { sessionId: SessionId; api: ApiClient }): null {
    handle = useLiveSession(api, sessionId);
    return null;
  }

  it('does not let an in-flight refresh erase a newer socket event', async () => {
    const { api, pending } = deferredApi();

    act(() => {
      root.render(createElement(Harness, { api, sessionId: FIRST }));
    });
    expect(pending[0]?.path).toBe(`/sessions/${FIRST}`);

    await act(async () => {
      pending[0]?.resolve(detail(FIRST, 'First session'));
      await Promise.resolve();
    });
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();

    let refresh: Promise<void> | undefined;
    act(() => {
      refresh = handle.refresh();
    });
    expect(pending).toHaveLength(2);

    act(() => {
      socket?.event(
        event(FIRST, 1, {
          type: 'agent.message',
          message: {
            messageId: MessageIdSchema.parse('msg_ccccccccccccccccccccc'),
            role: 'agent',
            text: 'This arrived while refresh was waiting.',
            sentAt: AT,
          },
        }),
      );
    });

    await act(async () => {
      pending[1]?.resolve(detail(FIRST, 'First session'));
      await refresh;
    });

    expect(handle.live?.messages.map((message) => message.text)).toEqual([
      'This arrived while refresh was waiting.',
    ]);
  });

  it('clears the previous session immediately and ignores its late events', async () => {
    const { api, pending } = deferredApi();

    act(() => {
      root.render(createElement(Harness, { api, sessionId: FIRST }));
    });
    await act(async () => {
      pending[0]?.resolve(detail(FIRST, 'First session'));
      await Promise.resolve();
    });
    const firstSocket = FakeSocket.instances[0];

    act(() => {
      root.render(createElement(Harness, { api, sessionId: SECOND }));
    });
    expect(handle.load).toBe('loading');
    expect(handle.detail).toBeNull();
    expect(handle.live).toBeNull();

    act(() => {
      firstSocket?.event(
        event(FIRST, 1, {
          type: 'session.status',
          status: 'working',
          progress: { step: 9, maxSteps: 30, currentActivity: 'stale first session event' },
        }),
      );
    });

    await act(async () => {
      pending[1]?.resolve(detail(SECOND, 'Second session'));
      await Promise.resolve();
    });

    expect(handle.detail?.sessionId).toBe(SECOND);
    expect(handle.live?.progress.currentActivity).toBe('Second session');
  });
});
