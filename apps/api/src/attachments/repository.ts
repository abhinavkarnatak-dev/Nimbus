import type { Db } from 'mongodb';

import { attachmentsCollection, type AttachmentDocument } from '../db/models/attachment.js';

export type NewAttachment = AttachmentDocument;

export interface AttachmentRecords {
  insert(document: NewAttachment): Promise<void>;
  findOwned(userId: string, attachmentId: string): Promise<AttachmentDocument | null>;
  claim(attachmentId: string, sessionId: string): Promise<boolean>;
  countUnclaimed(userId: string): Promise<number>;
  remove(attachmentId: string): Promise<boolean>;
  findExpired(now: Date, limit: number): Promise<AttachmentDocument[]>;
  saveDescription(attachmentId: string, description: string, model: string): Promise<void>;
}

export class MongoAttachmentRecords implements AttachmentRecords {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async insert(document: NewAttachment): Promise<void> {
    await attachmentsCollection(this.db).insertOne({ ...document });
  }

  async findOwned(userId: string, attachmentId: string): Promise<AttachmentDocument | null> {
    return attachmentsCollection(this.db).findOne({ attachmentId, userId });
  }

  async saveDescription(attachmentId: string, description: string, model: string): Promise<void> {
    await attachmentsCollection(this.db).updateOne(
      { attachmentId },
      { $set: { description, describedByModel: model, describedAt: new Date() } },
    );
  }

  async claim(attachmentId: string, sessionId: string): Promise<boolean> {
    const result = await attachmentsCollection(this.db).updateOne(
      { attachmentId, sessionId: null },
      { $set: { sessionId, expiresAt: null } },
    );

    return result.modifiedCount === 1;
  }

  async countUnclaimed(userId: string): Promise<number> {
    return attachmentsCollection(this.db).countDocuments({ userId, sessionId: null });
  }

  async remove(attachmentId: string): Promise<boolean> {
    const result = await attachmentsCollection(this.db).deleteOne({ attachmentId });
    return result.deletedCount === 1;
  }

  async findExpired(now: Date, limit: number): Promise<AttachmentDocument[]> {
    return attachmentsCollection(this.db)
      .find({ sessionId: null, expiresAt: { $ne: null, $lte: now } })
      .sort({ expiresAt: 1 })
      .limit(limit)
      .toArray();
  }
}

export class InMemoryAttachmentRecords implements AttachmentRecords {
  readonly documents: AttachmentDocument[] = [];

  async saveDescription(attachmentId: string, description: string, model: string): Promise<void> {
    const held = this.documents.find((one) => one.attachmentId === attachmentId);

    if (held !== undefined) {
      held.description = description;
      held.describedByModel = model;
      held.describedAt = new Date();
    }
    return Promise.resolve();
  }

  async insert(document: NewAttachment): Promise<void> {
    if (this.documents.some((held) => held.attachmentId === document.attachmentId)) {
      throw new Error('duplicate attachment id');
    }
    this.documents.push({ ...document });
    return Promise.resolve();
  }

  async findOwned(userId: string, attachmentId: string): Promise<AttachmentDocument | null> {
    const found = this.documents.find(
      (held) => held.attachmentId === attachmentId && held.userId === userId,
    );
    return Promise.resolve(found ?? null);
  }

  async claim(attachmentId: string, sessionId: string): Promise<boolean> {
    const held = this.documents.find(
      (one) => one.attachmentId === attachmentId && one.sessionId === null,
    );

    if (held === undefined) {
      return Promise.resolve(false);
    }

    held.sessionId = sessionId;
    held.expiresAt = null;
    return Promise.resolve(true);
  }

  async countUnclaimed(userId: string): Promise<number> {
    return Promise.resolve(
      this.documents.filter((held) => held.userId === userId && held.sessionId === null).length,
    );
  }

  async remove(attachmentId: string): Promise<boolean> {
    const at = this.documents.findIndex((held) => held.attachmentId === attachmentId);
    if (at < 0) {
      return Promise.resolve(false);
    }
    this.documents.splice(at, 1);
    return Promise.resolve(true);
  }

  async findExpired(now: Date, limit: number): Promise<AttachmentDocument[]> {
    return Promise.resolve(
      this.documents
        .filter(
          (held) =>
            held.sessionId === null &&
            held.expiresAt !== null &&
            held.expiresAt.getTime() <= now.getTime(),
        )
        .sort((left, right) => (left.expiresAt?.getTime() ?? 0) - (right.expiresAt?.getTime() ?? 0))
        .slice(0, limit),
    );
  }
}
