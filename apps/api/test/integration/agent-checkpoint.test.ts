import { createTestDatabase, type TestDatabase } from '@nimbus/test-utils';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  BASE_COMMIT,
  OTHER_COMMIT,
  SESSION_ID,
  sampleState,
} from '../../src/agent/state/agent-state.fixtures.js';
import { MongoCheckpointSaver, readKey } from '../../src/agent/state/mongo-saver.js';
import { STATE_LIMITS } from '../../src/agent/state/limits.js';
import { parseState, recordFileRead, withPhase } from '../../src/agent/state/state.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { checkpointsCollection } from '../../src/db/models/checkpoint.js';

let testDatabase: TestDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase('nimbus_checkpoint');
  await ensureDatabaseSchema(testDatabase.db);
});

afterEach(async () => {
  await checkpointsCollection(testDatabase.db).deleteMany({});
});

afterAll(async () => {
  await testDatabase.cleanup();
});

function saver(overrides: Partial<ConstructorParameters<typeof MongoCheckpointSaver>[0]> = {}) {
  return new MongoCheckpointSaver({
    db: testDatabase.db,
    baseCommitSha: BASE_COMMIT,
    ...overrides,
  });
}

const config = { configurable: { thread_id: SESSION_ID, checkpoint_ns: '' } };

const AgentAnnotation = Annotation.Root({
  state: Annotation<ReturnType<typeof sampleState>>({
    reducer: (_held, next) => next,
    default: () => sampleState(),
  }),
});

function buildGraph(checkpointer: MongoCheckpointSaver) {
  return new StateGraph(AgentAnnotation)
    .addNode('work', (current) => ({
      state: recordFileRead(
        withPhase(current.state, 'executing'),
        `src/step${String(current.state.filesRead.length)}.ts`,
      ),
    }))
    .addEdge(START, 'work')
    .addEdge('work', END)
    .compile({ checkpointer });
}

describe('readKey', () => {
  it('refuses a checkpoint with no session', () => {
    expect(() => readKey({ configurable: {} })).toThrow(
      expect.objectContaining({ code: 'STATE_INVALID' }) as Error,
    );
  });

  it('reads the thread, namespace and checkpoint', () => {
    expect(
      readKey({ configurable: { thread_id: SESSION_ID, checkpoint_ns: 'x', checkpoint_id: 'c1' } }),
    ).toEqual({ threadId: SESSION_ID, namespace: 'x', checkpointId: 'c1' });
  });
});

describe('saving and resuming a real graph', () => {
  it('writes a checkpoint that survives the process', async () => {
    const graph = buildGraph(saver());
    const first = await graph.invoke({ state: sampleState() }, config);

    expect(first.state.phase).toBe('executing');
    expect(first.state.filesRead).toEqual(['src/step0.ts']);

    const stored = await checkpointsCollection(testDatabase.db).findOne({ threadId: SESSION_ID });
    expect(stored).not.toBeNull();
    expect(stored?.stateVersion).toBe(1);
    expect(stored?.baseCommitSha).toBe(BASE_COMMIT);
    expect(stored?.byteSize).toBeGreaterThan(0);
  });

  it('resumes from what a different saver instance wrote', async () => {
    await buildGraph(saver()).invoke({ state: sampleState() }, config);

    const resumed = saver();
    const tuple = await resumed.getTuple(config);

    expect(tuple).toBeDefined();
    const values = tuple?.checkpoint.channel_values as { state?: unknown };
    expect(parseState(values.state).filesRead).toEqual(['src/step0.ts']);
  });

  it('carries on from where it stopped rather than starting over', async () => {
    const checkpointer = saver();
    await buildGraph(checkpointer).invoke({ state: sampleState() }, config);
    const second = await buildGraph(checkpointer).invoke({}, config);

    expect(second.state.filesRead).toEqual(['src/step0.ts', 'src/step1.ts']);
  });

  it('resumes the latest checkpoint, not an older one', async () => {
    const checkpointer = saver();
    await buildGraph(checkpointer).invoke({ state: sampleState() }, config);
    await buildGraph(checkpointer).invoke({}, config);

    const count = await checkpointsCollection(testDatabase.db).countDocuments({
      threadId: SESSION_ID,
    });
    expect(count).toBeGreaterThan(1);

    const tuple = await checkpointer.getTuple(config);
    const values = tuple?.checkpoint.channel_values as { state?: unknown };
    expect(parseState(values.state).filesRead).toHaveLength(2);
  });

  it('keeps one session apart from another', async () => {
    const other = { configurable: { thread_id: 'ses_otherotherotherothero', checkpoint_ns: '' } };
    const checkpointer = saver();

    await buildGraph(checkpointer).invoke({ state: sampleState() }, config);
    expect(await checkpointer.getTuple(other)).toBeUndefined();
  });
});

describe('refusing to resume', () => {
  it('refuses a checkpoint written by an older version', async () => {
    await buildGraph(saver()).invoke({ state: sampleState() }, config);

    await expect(saver({ stateVersion: 2 }).getTuple(config)).rejects.toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_STALE' }) as Error,
    );
  });

  it('refuses a checkpoint from a different base commit', async () => {
    await buildGraph(saver()).invoke({ state: sampleState() }, config);

    await expect(saver({ baseCommitSha: OTHER_COMMIT }).getTuple(config)).rejects.toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_STALE' }) as Error,
    );
  });

  it('refuses a checkpoint that has expired', async () => {
    await buildGraph(saver()).invoke({ state: sampleState() }, config);

    const later = new Date(Date.now() + STATE_LIMITS.checkpointMaxAgeMs + 60_000);

    await expect(saver({ now: () => later }).getTuple(config)).rejects.toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_STALE' }) as Error,
    );
  });

  it('refuses a checkpoint whose bytes are not json', async () => {
    await buildGraph(saver()).invoke({ state: sampleState() }, config);
    await checkpointsCollection(testDatabase.db).updateMany(
      {},
      { $set: { checkpoint: '{not json' } },
    );

    await expect(saver().getTuple(config)).rejects.toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_CORRUPT' }) as Error,
    );
  });

  it('refuses a checkpoint that is json but not a checkpoint', async () => {
    await buildGraph(saver()).invoke({ state: sampleState() }, config);
    await checkpointsCollection(testDatabase.db).updateMany(
      {},
      { $set: { checkpoint: '{"hello":"world"}' } },
    );

    await expect(saver().getTuple(config)).rejects.toThrow(
      expect.objectContaining({ code: 'CHECKPOINT_CORRUPT' }) as Error,
    );
  });

  it('never hands back a partly rebuilt state', async () => {
    await buildGraph(saver()).invoke({ state: sampleState() }, config);
    await checkpointsCollection(testDatabase.db).updateMany({}, { $set: { checkpoint: '{bad' } });

    let outcome: string;

    try {
      const tuple = await saver().getTuple(config);
      outcome = tuple === undefined ? 'nothing' : 'a rebuilt state';
    } catch {
      outcome = 'refused';
    }

    expect(outcome).toBe('refused');
  });
});

describe('what must never be stored', () => {
  it('refuses to write a state holding a credential', async () => {
    const hostile = parseState({
      ...sampleState(),
      task: 'push using ghp_abcdefghijklmnopqrstuvwxyz0123',
    });

    await expect(buildGraph(saver()).invoke({ state: hostile }, config)).rejects.toThrow(
      expect.objectContaining({ code: 'STATE_HOLDS_CREDENTIAL' }) as Error,
    );

    expect(await checkpointsCollection(testDatabase.db).countDocuments({})).toBe(0);
  });

  it('stores nothing at all when it refuses', async () => {
    const hostile = parseState({
      ...sampleState(),
      task: 'connect to mongodb://user:pass@host/db',
    });

    await expect(buildGraph(saver()).invoke({ state: hostile }, config)).rejects.toThrow(
      expect.objectContaining({ code: 'STATE_HOLDS_CREDENTIAL' }) as Error,
    );

    expect(await checkpointsCollection(testDatabase.db).countDocuments({})).toBe(0);
  });
});

describe('deleteThread', () => {
  it('removes one session and leaves the others alone', async () => {
    const other = { configurable: { thread_id: 'ses_otherotherotherothero', checkpoint_ns: '' } };
    const checkpointer = saver();

    await buildGraph(checkpointer).invoke({ state: sampleState() }, config);
    await buildGraph(checkpointer).invoke({ state: sampleState() }, other);

    await checkpointer.deleteThread(SESSION_ID);

    expect(
      await checkpointsCollection(testDatabase.db).countDocuments({ threadId: SESSION_ID }),
    ).toBe(0);
    expect(
      await checkpointsCollection(testDatabase.db).countDocuments({
        threadId: 'ses_otherotherotherothero',
      }),
    ).toBeGreaterThan(0);
  });
});
