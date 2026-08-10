import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { newPrefixedId } from '../../lib/id.js';
import { REDACTED } from '../../logging/redact.js';
import { AUDIT_RETENTION_DAYS, buildAuditEvent } from './audit-event.js';
import { toInstallationSummary } from './github-installation.js';
import { makeInstallation, makeSession, makeUser } from './model.fixtures.js';
import { ACTIVE_SESSION_STATUSES, isActiveSessionStatus, toSessionDetail } from './session.js';
import { normalizeEmail, toAuthenticatedUser } from './user.js';

describe('normalizeEmail', () => {
  it('lowercases and trims so one person is one account', () => {
    expect(normalizeEmail('  Abhinav@Example.COM ')).toBe('abhinav@example.com');
  });

  it('leaves an already normal address alone', () => {
    expect(normalizeEmail('abhinav@example.com')).toBe('abhinav@example.com');
  });
});

describe('mappers never leak the mongodb id', () => {
  it('omits _id from an authenticated user', () => {
    const stored = { ...makeUser(), _id: new ObjectId() };
    const mapped = toAuthenticatedUser(stored);

    expect(Object.keys(mapped)).not.toContain('_id');
    expect(JSON.stringify(mapped)).not.toContain(stored._id.toHexString());
  });

  it('omits _id from an installation summary', () => {
    const stored = { ...makeInstallation(newPrefixedId('usr')), _id: new ObjectId() };
    const mapped = toInstallationSummary(stored);

    expect(Object.keys(mapped)).not.toContain('_id');
  });

  it('omits _id from a session detail', () => {
    const stored = { ...makeSession(newPrefixedId('usr')), _id: new ObjectId() };
    const mapped = toSessionDetail(stored);

    expect(Object.keys(mapped)).not.toContain('_id');
    expect(JSON.stringify(mapped)).not.toContain(stored._id.toHexString());
  });
});

describe('mappers produce wire safe timestamps', () => {
  it('turns dates into iso strings', () => {
    const createdAt = new Date('2026-08-11T09:30:00.000Z');
    const mapped = toAuthenticatedUser(makeUser({ createdAt, lastLoginAt: createdAt }));

    expect(mapped.createdAt).toBe('2026-08-11T09:30:00.000Z');
    expect(mapped.lastLoginAt).toBe('2026-08-11T09:30:00.000Z');
  });
});

describe('active session statuses', () => {
  it('excludes every terminal status', () => {
    expect([...ACTIVE_SESSION_STATUSES]).toEqual([
      'queued',
      'provisioning',
      'indexing',
      'working',
      'awaiting_user',
      'validating',
      'pushing',
    ]);
  });

  it('treats finished sessions as inactive', () => {
    expect(isActiveSessionStatus('pr_created')).toBe(false);
    expect(isActiveSessionStatus('failed')).toBe(false);
    expect(isActiveSessionStatus('cancelled')).toBe(false);
  });

  it('treats unfinished sessions as active', () => {
    expect(isActiveSessionStatus('queued')).toBe(true);
    expect(isActiveSessionStatus('working')).toBe(true);
  });
});

describe('buildAuditEvent', () => {
  it('redacts secrets that a caller passes in metadata', () => {
    const event = buildAuditEvent({
      action: 'github.token.minted',
      outcome: 'success',
      actorType: 'system',
      metadata: {
        installationToken: 'ghs_abcdefghijklmnopqrstuvwxyz012345',
        repositoryCount: 1,
      },
    });

    expect(event.metadata['installationToken']).toBe(REDACTED);
    expect(event.metadata['repositoryCount']).toBe(1);
  });

  it('redacts a secret hiding inside a metadata string', () => {
    const event = buildAuditEvent({
      action: 'admin.failure',
      outcome: 'failure',
      actorType: 'system',
      metadata: { detail: 'call failed using github_pat_11ABCDEFG0abcdefghijklmnop' },
    });

    expect(event.metadata['detail']).not.toContain('github_pat_11ABCDEFG0');
  });

  it('defaults every optional subject field to null rather than undefined', () => {
    const event = buildAuditEvent({
      action: 'auth.login',
      outcome: 'success',
      actorType: 'user',
    });

    expect(event.userId).toBeNull();
    expect(event.sessionId).toBeNull();
    expect(event.repositoryId).toBeNull();
    expect(event.ip).toBeNull();
    expect(event.metadata).toEqual({});
  });

  it('sets an expiry that matches the retention period', () => {
    const now = new Date('2026-08-11T00:00:00.000Z');
    const event = buildAuditEvent({
      action: 'auth.login',
      outcome: 'success',
      actorType: 'user',
      now,
    });

    const days = (event.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(AUDIT_RETENTION_DAYS);
  });

  it('gives every event a distinct prefixed id', () => {
    const first = buildAuditEvent({ action: 'auth.login', outcome: 'success', actorType: 'user' });
    const second = buildAuditEvent({ action: 'auth.login', outcome: 'success', actorType: 'user' });

    expect(first.auditEventId).toMatch(/^aud_[0-9A-Za-z_-]{21}$/);
    expect(first.auditEventId).not.toBe(second.auditEventId);
  });
});
