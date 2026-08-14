import { createTestDatabase, type TestDatabase } from '@nimbus/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CLEAR_SCOPE,
  REDIRECT_PATCH,
  action,
  graphHarness,
} from '../../src/agent/graph/graph.fixtures.js';
import { runAgent } from '../../src/agent/graph/run.js';
import { MongoCheckpointSaver } from '../../src/agent/state/mongo-saver.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { checkpointsCollection } from '../../src/db/models/checkpoint.js';

let testDatabase: TestDatabase;

const READ = action('read_file', { path: 'src/routing/redirect.ts' });
const PATCH = action('apply_patch', { patch: REDIRECT_PATCH });
const CHECKS = action('run_checks', { name: 'unit tests', kind: 'test', argv: ['pnpm', 'test'] });
const COMMIT = action('prepare_commit', { summary: 'send people back where they came from' });
const WORKFLOW = action('create_file', {
  path: '.github/workflows/deploy.yml',
  contents: 'name: deploy\n',
});

beforeAll(async () => {
  testDatabase = await createTestDatabase('nimbus_agent_run');
  await ensureDatabaseSchema(testDatabase.db);
});

afterEach(async () => {
  await checkpointsCollection(testDatabase.db).deleteMany({});
});

afterAll(async () => {
  await testDatabase.cleanup();
});

async function harnessWithSaver(
  options: Parameters<typeof graphHarness>[0] = {},
): Promise<Awaited<ReturnType<typeof graphHarness>>> {
  const harness = await graphHarness(options);

  return {
    ...harness,
    checkpointer: new MongoCheckpointSaver({
      db: testDatabase.db,
      baseCommitSha: harness.state.baseCommitSha,
    }),
  };
}

describe('a whole run against a real checkpoint store', () => {
  it('finishes and hands over a patch', async () => {
    const harness = await harnessWithSaver({
      answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT],
    });

    const result = await runAgent(harness);

    expect(result.state.stopReason).toBe('completed');
    expect(result.report?.changedFiles).toBe(1);
  });

  it('leaves a checkpoint behind that a later process could read', async () => {
    const harness = await harnessWithSaver({
      answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT],
    });

    await runAgent(harness);

    const stored = await checkpointsCollection(testDatabase.db).findOne({
      threadId: harness.state.sessionId,
    });

    expect(stored).not.toBeNull();
    expect(stored?.baseCommitSha).toBe(harness.state.baseCommitSha);
  });

  it('checkpoints a run that paused for approval, so the wait survives a restart', async () => {
    const harness = await harnessWithSaver({ answers: [CLEAR_SCOPE, WORKFLOW] });

    const result = await runAgent(harness);

    expect(result.state.phase).toBe('awaiting_approval');

    const saver = new MongoCheckpointSaver({
      db: testDatabase.db,
      baseCommitSha: harness.state.baseCommitSha,
    });

    const tuple = await saver.getTuple({
      configurable: { thread_id: harness.state.sessionId, checkpoint_ns: '' },
    });

    expect(tuple).not.toBeUndefined();
  });

  it('checkpoints a run that stopped to ask a question', async () => {
    const harness = await harnessWithSaver({
      task: 'make the authentication flow nicer for users',
      answers: [{ value: { clear: false, question: 'Which page should people land on?' } }],
    });

    await runAgent(harness);

    const stored = await checkpointsCollection(testDatabase.db).findOne({
      threadId: harness.state.sessionId,
    });

    expect(stored).not.toBeNull();
  });

  it('writes a checkpoint that holds no credential', async () => {
    const harness = await harnessWithSaver({
      answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT],
    });

    await runAgent(harness);

    const stored = await checkpointsCollection(testDatabase.db).findOne({
      threadId: harness.state.sessionId,
    });

    expect(JSON.stringify(stored)).not.toContain(harness.reference.token);
  });

  it('keeps one session apart from another', async () => {
    const first = await harnessWithSaver({ answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT] });
    const second = await harnessWithSaver({ answers: [CLEAR_SCOPE, READ, PATCH, CHECKS, COMMIT] });

    await runAgent(first);
    await runAgent(second);

    const rows = await checkpointsCollection(testDatabase.db)
      .find({ threadId: first.state.sessionId })
      .toArray();

    expect(rows.every((row) => row.threadId === first.state.sessionId)).toBe(true);
  });
});
