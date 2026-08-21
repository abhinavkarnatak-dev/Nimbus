import { AuthenticatedUserSchema, type AuthenticatedUser } from '@nimbus/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { jpegBytes, pngBytes, textBytes } from '../attachments/attachment.fixtures.js';
import { FakeAttachmentStore } from '../attachments/fake-store.js';
import { InMemoryAttachmentRecords } from '../attachments/repository.js';
import { AttachmentService } from '../attachments/service.js';
import { createApp } from '../app.js';
import { CSRF_HEADER } from '../auth/csrf.js';
import type { ActiveSession } from '../auth/session-service.js';
import { SESSION_COOKIE_NAME } from './cookies.js';
import { createTestLogger, testConfig } from './http.fixtures.js';
import { createAttachSession } from './middleware/session.js';
import { DOWNLOAD_HEADERS, createAttachmentsRouter } from './routes/attachments.js';

const SESSION_ID = 'session-id-value';
const CSRF_TOKEN = 'csrf-token-value';
const COOKIE = `${SESSION_COOKIE_NAME}=${SESSION_ID}`;

const USER: AuthenticatedUser = AuthenticatedUserSchema.parse({
  userId: 'usr_V1StGXR8Z5jdHi6BmyTab',
  email: 'person@example.com',
  displayName: 'person',
  authProviders: ['email_otp'],
  createdAt: '2026-08-14T00:00:00.000Z',
  lastLoginAt: '2026-08-14T00:00:00.000Z',
});

const OTHER_USER: AuthenticatedUser = AuthenticatedUserSchema.parse({
  ...USER,
  userId: 'usr_TabmyB6iHd5Z8RXGtS1Vx',
  email: 'other@example.com',
});

function sessionFor(user: AuthenticatedUser): ActiveSession {
  return {
    sessionId: SESSION_ID,
    sessionKey: 'hashed',
    csrfToken: CSRF_TOKEN,
    expiresInSeconds: 604_800,
    user,
    record: {
      userId: user.userId,
      createdAt: '2026-08-14T00:00:00.000Z',
      absoluteExpiresAt: '2026-08-15T00:00:00.000Z',
    },
  };
}

let records: InMemoryAttachmentRecords;
let store: FakeAttachmentStore;
let service: AttachmentService;

beforeEach(() => {
  records = new InMemoryAttachmentRecords();
  store = new FakeAttachmentStore();
  service = new AttachmentService({ records, store });
});

function harness(
  options: { signedIn?: boolean; user?: AuthenticatedUser; maxBytes?: number } = {},
): Express {
  const { logger } = createTestLogger();
  const user = options.user ?? USER;

  const sessions = {
    load: async (sessionId: string): Promise<ActiveSession | null> => {
      await Promise.resolve();
      return options.signedIn !== false && sessionId === SESSION_ID ? sessionFor(user) : null;
    },
    csrfMatches: (session: ActiveSession, token: string): boolean => session.csrfToken === token,
  };

  return createApp({
    config: testConfig(),
    logger,
    routers: [
      createAttachmentsRouter({
        attachments: service,
        sessions,
        maxBytes: options.maxBytes ?? 5_242_880,
      }),
    ],
    attachSession: createAttachSession(sessions, false),
  });
}

async function uploadPng(app: Express): Promise<string> {
  const response = await request(app)
    .post('/attachments')
    .set('Cookie', COOKIE)
    .set(CSRF_HEADER, CSRF_TOKEN)
    .attach('file', await pngBytes(), { filename: 'shot.png', contentType: 'image/png' });

  return (response.body as { attachment: { attachmentId: string } }).attachment.attachmentId;
}

describe('POST /attachments', () => {
  it('accepts a real png', async () => {
    const response = await request(harness())
      .post('/attachments')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .attach('file', await pngBytes(), { filename: 'shot.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      attachment: { kind: 'image', mimeType: 'image/png', originalName: 'shot.png' },
    });
  });

  it('accepts a markdown note', async () => {
    const response = await request(harness())
      .post('/attachments')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .attach('file', textBytes('# steps to reproduce'), {
        filename: 'notes.md',
        contentType: 'text/markdown',
      });

    expect(response.status).toBe(201);
  });

  it('refuses a stranger', async () => {
    const response = await request(harness({ signedIn: false }))
      .post('/attachments')
      .attach('file', await pngBytes(), { filename: 'shot.png', contentType: 'image/png' });

    expect(response.status).toBe(401);
    expect(store.putKeys).toHaveLength(0);
  });

  it('refuses a request without the csrf token', async () => {
    const response = await request(harness())
      .post('/attachments')
      .set('Cookie', COOKIE)
      .attach('file', await pngBytes(), { filename: 'shot.png', contentType: 'image/png' });

    expect(response.status).toBe(403);
    expect(store.putKeys).toHaveLength(0);
  });

  it('refuses jpeg bytes wearing a png name and type', async () => {
    const response = await request(harness())
      .post('/attachments')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .attach('file', await jpegBytes(), { filename: 'shot.png', contentType: 'image/png' });

    expect(response.status).toBe(415);
  });

  it('refuses an svg', async () => {
    const response = await request(harness())
      .post('/attachments')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .attach('file', textBytes('<svg onload="alert(1)"/>'), {
        filename: 'logo.svg',
        contentType: 'image/svg+xml',
      });

    expect(response.status).toBe(415);
  });

  it('refuses a file bigger than the limit', async () => {
    const response = await request(harness({ maxBytes: 512 }))
      .post('/attachments')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .attach('file', textBytes('x'.repeat(4000)), {
        filename: 'big.txt',
        contentType: 'text/plain',
      });

    expect(response.status).toBe(413);
    expect(store.putKeys).toHaveLength(0);
  });

  it('refuses a body that is not a multipart form', async () => {
    const response = await request(harness())
      .post('/attachments')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .send({ file: 'pretend' });

    expect(response.status).toBe(415);
  });

  it('refuses a multipart form with no file in it', async () => {
    const response = await request(harness())
      .post('/attachments')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .field('note', 'nothing attached');

    expect(response.status).toBe(400);
  });

  it('never lets a path in the file name become a storage path', async () => {
    await request(harness())
      .post('/attachments')
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN)
      .attach('file', await pngBytes(), {
        filename: '../../../etc/passwd.png',
        contentType: 'image/png',
      });

    expect(store.putKeys[0]).toMatch(/^attachments\/usr_[0-9A-Za-z_-]+\/att_[0-9A-Za-z_-]+$/);
    expect(records.documents[0]?.originalName).toBe('passwd.png');
  });
});

describe('GET /attachments/:attachmentId', () => {
  it('returns the file to its owner with every protective header', async () => {
    const app = harness();
    const attachmentId = await uploadPng(app);

    const response = await request(app).get(`/attachments/${attachmentId}`).set('Cookie', COOKIE);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['content-disposition']).toContain('attachment;');

    for (const [name, value] of Object.entries(DOWNLOAD_HEADERS)) {
      expect(response.headers[name.toLowerCase()]).toBe(value);
    }
  });

  it('hides an attachment belonging to somebody else', async () => {
    const attachmentId = await uploadPng(harness());

    const response = await request(harness({ user: OTHER_USER }))
      .get(`/attachments/${attachmentId}`)
      .set('Cookie', COOKIE);

    expect(response.status).toBe(404);
  });

  it('treats a malformed identifier as not found', async () => {
    const response = await request(harness())
      .get('/attachments/..%2F..%2Fetc%2Fpasswd')
      .set('Cookie', COOKIE);

    expect(response.status).toBe(404);
  });

  it('refuses a stranger', async () => {
    const attachmentId = await uploadPng(harness());

    const response = await request(harness({ signedIn: false })).get(
      `/attachments/${attachmentId}`,
    );

    expect(response.status).toBe(401);
  });
});

describe('DELETE /attachments/:attachmentId', () => {
  it('removes the file and the record', async () => {
    const app = harness();
    const attachmentId = await uploadPng(app);

    const response = await request(app)
      .delete(`/attachments/${attachmentId}`)
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN);

    expect(response.status).toBe(204);
    expect(records.documents).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it('refuses without the csrf token', async () => {
    const app = harness();
    const attachmentId = await uploadPng(app);

    const response = await request(app)
      .delete(`/attachments/${attachmentId}`)
      .set('Cookie', COOKIE);

    expect(response.status).toBe(403);
    expect(records.documents).toHaveLength(1);
  });

  it('refuses to delete an attachment belonging to somebody else', async () => {
    const attachmentId = await uploadPng(harness());

    const response = await request(harness({ user: OTHER_USER }))
      .delete(`/attachments/${attachmentId}`)
      .set('Cookie', COOKIE)
      .set(CSRF_HEADER, CSRF_TOKEN);

    expect(response.status).toBe(404);
    expect(records.documents).toHaveLength(1);
  });
});
