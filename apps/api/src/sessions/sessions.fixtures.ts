import {
  CreateSessionBodySchema,
  RepositorySummarySchema,
  type CreateSessionBody,
  type RepositorySummary,
} from '@nimbus/contracts';

import { InMemoryAttachmentRecords } from '../attachments/repository.js';
import type { AttachmentDocument } from '../db/models/attachment.js';
import { capturingLogger } from '../llm/llm.fixtures.js';
import { InMemorySessionRecords } from './repository.js';
import { AgentSessionService, type RepositoryDirectory } from './service.js';

export const ID_BODY_LENGTH = 21;

export function testId(prefix: string, word: string): string {
  return `${prefix}_${word.repeat(ID_BODY_LENGTH).slice(0, ID_BODY_LENGTH)}`;
}

export const OWNER_ID = testId('usr', 'owner');
export const OTHER_ID = testId('usr', 'other');

export const SHOPFRONT: RepositorySummary = RepositorySummarySchema.parse({
  repositoryId: 41,
  owner: 'shopfront',
  name: 'web',
  defaultBranch: 'main',
  visibility: 'public',
  htmlUrl: 'https://github.com/shopfront/web',
  updatedAt: '2026-08-01T09:00:00.000Z',
});

export const HIDDEN: RepositorySummary = RepositorySummarySchema.parse({
  ...SHOPFRONT,
  repositoryId: 99,
  name: 'private-notes',
});

export const CLEAR_TASK = 'the login redirect always sends people to the dashboard';

export function newBody(
  overrides: Partial<{
    repositoryId: number;
    task: string;
    attachmentIds: string[];
    idempotencyKey: string;
  }> = {},
): CreateSessionBody {
  return CreateSessionBodySchema.parse({
    repositoryId: SHOPFRONT.repositoryId,
    task: CLEAR_TASK,
    attachmentIds: [],
    idempotencyKey: testId('idk', 'a'),
    ...overrides,
  });
}

export function attachment(overrides: Partial<AttachmentDocument> = {}): AttachmentDocument {
  return {
    attachmentId: testId('att', 'b'),
    userId: OWNER_ID,
    sessionId: null,
    kind: 'text',
    mimeType: 'text/plain',
    byteSize: 12,
    originalName: 'notes.txt',
    checksum: 'a'.repeat(64),
    storageKey: 'attachments/one',
    description: null,
    describedByModel: null,
    describedAt: null,
    width: null,
    height: null,
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    expiresAt: new Date('2026-08-02T09:00:00.000Z'),
    ...overrides,
  };
}

export class FakeRepositoryDirectory implements RepositoryDirectory {
  readonly calls: string[] = [];

  #repositories: RepositorySummary[];

  #failure: Error | null = null;

  constructor(repositories: RepositorySummary[] = [SHOPFRONT]) {
    this.#repositories = repositories;
  }

  failWith(error: Error): void {
    this.#failure = error;
  }

  async listRepositories(userId: string): Promise<{ repositories: RepositorySummary[] }> {
    this.calls.push(userId);

    if (this.#failure !== null) {
      throw this.#failure;
    }
    return Promise.resolve({ repositories: this.#repositories });
  }
}

export interface SessionHarness {
  service: AgentSessionService;
  records: InMemorySessionRecords;
  attachments: InMemoryAttachmentRecords;
  directory: FakeRepositoryDirectory;
  logs: () => string;
}

export function sessionHarness(
  options: { repositories?: RepositorySummary[]; now?: () => Date } = {},
): SessionHarness {
  const captured = capturingLogger();
  const records = new InMemorySessionRecords();
  const attachments = new InMemoryAttachmentRecords();
  const directory = new FakeRepositoryDirectory(options.repositories ?? [SHOPFRONT]);

  return {
    service: new AgentSessionService({
      records,
      attachments,
      repositories: directory,
      logger: captured.logger,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    records,
    attachments,
    directory,
    logs: captured.text,
  };
}
