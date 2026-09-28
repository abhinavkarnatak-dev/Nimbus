import type { Db } from 'mongodb';

import {
  codexCredentialBinding,
  codexCredentialsCollection,
} from '../db/models/codex-credential.js';
import type { SecretBox } from '../lib/secret-box.js';

export interface CodexCredentialStore {
  save(userId: string, contents: string): Promise<void>;
  load(userId: string): Promise<string | null>;
  remove(userId: string): Promise<void>;
}

export class MongoCodexCredentialStore implements CodexCredentialStore {
  readonly #db: Db;
  readonly #box: SecretBox;
  readonly #now: () => Date;

  constructor(options: { db: Db; box: SecretBox; now?: () => Date }) {
    this.#db = options.db;
    this.#box = options.box;
    this.#now = options.now ?? ((): Date => new Date());
  }

  async save(userId: string, contents: string): Promise<void> {
    const at = this.#now();
    await codexCredentialsCollection(this.#db).updateOne(
      { userId },
      {
        $set: {
          sealed: this.#box.seal(contents, codexCredentialBinding(userId)),
          updatedAt: at,
          lastSeenAt: at,
        },
        $setOnInsert: { userId, createdAt: at },
      },
      { upsert: true },
    );
  }

  async load(userId: string): Promise<string | null> {
    const document = await codexCredentialsCollection(this.#db).findOneAndUpdate(
      { userId },
      { $set: { lastSeenAt: this.#now() } },
      { returnDocument: 'after' },
    );
    if (document === null) return null;
    try {
      return this.#box.open(document.sealed, codexCredentialBinding(userId));
    } catch {
      return null;
    }
  }

  async remove(userId: string): Promise<void> {
    await codexCredentialsCollection(this.#db).deleteOne({ userId });
  }
}
