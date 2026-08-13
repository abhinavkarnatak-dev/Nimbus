import type { Db } from 'mongodb';

import { attachmentsCollection, type AttachmentDocument } from '../db/models/attachment.js';

export type NewAttachment = AttachmentDocument;

export interface AttachmentRecords {
  insert(document: NewAttachment): Promise<void>;
  findOwned(userId: string, attachmentId: string): Promise<AttachmentDocument | null>;
  countUnclaimed(userId: string): Promise<number>;
  remove(attachmentId: string): Promise<boolean>;
  findExpired(now: Date, limit: number): Promise<AttachmentDocument[]>;
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
