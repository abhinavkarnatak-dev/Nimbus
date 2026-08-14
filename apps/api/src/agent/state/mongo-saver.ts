import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import { AGENT_STATE_VERSION } from '@nimbus/contracts';
import type { Db } from 'mongodb';
import type { RunnableConfig } from '@langchain/core/runnables';

import {
  checkpointsCollection,
  type CheckpointDocument,
  type CheckpointWriteDocument,
} from '../../db/models/checkpoint.js';
import { AgentStateError } from './errors.js';
import { STATE_LIMITS } from './limits.js';
import { assertNoCredentials, assertWithinSize, toJson } from './sanitize.js';

export interface MongoSaverOptions {
  db: Db;
  baseCommitSha: string;
  stateVersion?: number;
  maxAgeMs?: number;
  now?: () => Date;
}

interface ThreadKey {
  threadId: string;
  namespace: string;
  checkpointId: string | null;
}

export const NEWEST_FIRST = { createdAt: -1, checkpointId: -1 } as const;

export function isCheckpointShaped(value: unknown): value is Checkpoint {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const held = value as { id?: unknown; channel_values?: unknown };
  return typeof held.id === 'string' && typeof held.channel_values === 'object';
}

export function readKey(config: RunnableConfig): ThreadKey {
  const configurable = (config.configurable ?? {}) as {
    thread_id?: unknown;
    checkpoint_ns?: unknown;
    checkpoint_id?: unknown;
  };

  const threadId = configurable.thread_id;

  if (typeof threadId !== 'string' || threadId === '') {
    throw new AgentStateError('STATE_INVALID', 'A checkpoint needs a session to belong to.');
  }

  return {
    threadId,
    namespace: typeof configurable.checkpoint_ns === 'string' ? configurable.checkpoint_ns : '',
    checkpointId:
      typeof configurable.checkpoint_id === 'string' ? configurable.checkpoint_id : null,
  };
}

export class MongoCheckpointSaver extends BaseCheckpointSaver {
  private readonly db: Db;

  private readonly baseCommitSha: string;

  private readonly stateVersion: number;

  private readonly maxAgeMs: number;

  private readonly now: () => Date;

  constructor(options: MongoSaverOptions, serde?: SerializerProtocol) {
    super(serde);
    this.db = options.db;
    this.baseCommitSha = options.baseCommitSha;
    this.stateVersion = options.stateVersion ?? AGENT_STATE_VERSION;
    this.maxAgeMs = options.maxAgeMs ?? STATE_LIMITS.checkpointMaxAgeMs;
    this.now = options.now ?? ((): Date => new Date());
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const key = readKey(config);
    const collection = checkpointsCollection(this.db);

    const document =
      key.checkpointId === null
        ? await collection.findOne(
            { threadId: key.threadId, namespace: key.namespace },
            { sort: NEWEST_FIRST },
          )
        : await collection.findOne({
            threadId: key.threadId,
            namespace: key.namespace,
            checkpointId: key.checkpointId,
          });

    if (document === null) {
      return undefined;
    }

    this.assertFresh(document);
    return await this.toTuple(document);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const key = readKey(config);
    const found = await checkpointsCollection(this.db)
      .find({ threadId: key.threadId, namespace: key.namespace })
      .sort(NEWEST_FIRST)
      .limit(options?.limit ?? 20)
      .toArray();

    for (const document of found) {
      yield await this.toTuple(document);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const key = readKey(config);
    const checkpointJson = this.dump(checkpoint);
    const metadataJson = this.dump(metadata);

    assertNoCredentials(checkpointJson);
    assertWithinSize(checkpointJson);

    const createdAt = this.now();
    const document: CheckpointDocument = {
      threadId: key.threadId,
      namespace: key.namespace,
      checkpointId: checkpoint.id,
      parentCheckpointId: key.checkpointId,
      stateVersion: this.stateVersion,
      baseCommitSha: this.baseCommitSha,
      checkpoint: checkpointJson,
      metadata: metadataJson,
      writes: [],
      byteSize: Buffer.byteLength(checkpointJson, 'utf8'),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.maxAgeMs),
    };

    await checkpointsCollection(this.db).updateOne(
      { threadId: key.threadId, namespace: key.namespace, checkpointId: checkpoint.id },
      { $set: document },
      { upsert: true },
    );

    return {
      configurable: {
        thread_id: key.threadId,
        checkpoint_ns: key.namespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const key = readKey(config);

    if (key.checkpointId === null) {
      throw new AgentStateError('STATE_INVALID', 'Those writes do not belong to a checkpoint.');
    }

    const stored: CheckpointWriteDocument[] = writes.map(([channel, value], index) => {
      const json = this.dump(value);
      assertNoCredentials(json);

      return { taskId, channel, index, type: 'json', value: json };
    });

    await checkpointsCollection(this.db).updateOne(
      { threadId: key.threadId, namespace: key.namespace, checkpointId: key.checkpointId },
      { $push: { writes: { $each: stored } } },
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    await checkpointsCollection(this.db).deleteMany({ threadId });
  }

  private assertFresh(document: CheckpointDocument): void {
    if (document.stateVersion !== this.stateVersion) {
      throw new AgentStateError(
        'CHECKPOINT_STALE',
        'That session was saved by an older version of Nimbus and cannot be resumed.',
        { detail: `version ${String(document.stateVersion)}` },
      );
    }

    if (document.baseCommitSha !== this.baseCommitSha) {
      throw new AgentStateError(
        'CHECKPOINT_STALE',
        'That session started from a different commit and cannot be resumed.',
      );
    }

    if (document.expiresAt.getTime() <= this.now().getTime()) {
      throw new AgentStateError('CHECKPOINT_STALE', 'That session is too old to be resumed.');
    }
  }

  private dump(value: unknown): string {
    const json = toJson(value);

    if (json === undefined) {
      throw new AgentStateError('STATE_INVALID', 'That checkpoint cannot be written down.');
    }
    return json;
  }

  private parse(json: string, what: string): unknown {
    try {
      return JSON.parse(json);
    } catch (error) {
      throw new AgentStateError('CHECKPOINT_CORRUPT', `That ${what} could not be read.`, {
        cause: error,
      });
    }
  }

  private async toTuple(document: CheckpointDocument): Promise<CheckpointTuple> {
    const raw = this.parse(document.checkpoint, 'checkpoint');

    if (!isCheckpointShaped(raw)) {
      throw new AgentStateError('CHECKPOINT_CORRUPT', 'That checkpoint is not shaped like one.');
    }

    const checkpoint = raw;
    const metadata = this.parse(document.metadata, 'checkpoint record') as CheckpointMetadata;

    const pendingWrites: [string, string, unknown][] = document.writes.map((write) => [
      write.taskId,
      write.channel,
      this.parse(write.value, 'checkpoint write'),
    ]);

    return await Promise.resolve({
      config: {
        configurable: {
          thread_id: document.threadId,
          checkpoint_ns: document.namespace,
          checkpoint_id: document.checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
      ...(document.parentCheckpointId === null
        ? {}
        : {
            parentConfig: {
              configurable: {
                thread_id: document.threadId,
                checkpoint_ns: document.namespace,
                checkpoint_id: document.parentCheckpointId,
              },
            },
          }),
    });
  }
}
