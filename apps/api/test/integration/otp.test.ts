import {
  createTestDatabase,
  createTestRedis,
  type TestDatabase,
  type TestRedis,
} from '@nimbus/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OtpService } from '../../src/auth/otp-service.js';
import { RESEND_COOLDOWN_SECONDS } from '../../src/auth/otp-policies.js';
import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { auditEventsCollection } from '../../src/db/models/audit-event.js';
import { usersCollection } from '../../src/db/models/user.js';
import { CapturingMailer } from '../../src/email/capturing-mailer.js';
import { MailService } from '../../src/email/mail-service.js';
import { ApiError } from '../../src/http/api-error.js';
import { createTestLogger, testConfig, type CapturedLog } from '../../src/http/http.fixtures.js';

const IP = '203.0.113.10';
const EMAIL = 'person@example.com';

let db: TestDatabase;
let redis: TestRedis;
let mailer: CapturingMailer;
let service: OtpService;
let lines: CapturedLog[];

function build(overrides: Record<string, string | undefined> = {}): OtpService {
  const captured = createTestLogger();
  lines = captured.lines;
  mailer = new CapturingMailer();

  return new OtpService({
    redis: redis.client,
    db: db.db,
    mail: new MailService(mailer, 'Nimbus <noreply@example.com>'),
    logger: captured.logger,
    config: testConfig(overrides),
  });
}

function codeFromLastEmail(): string {
  const text = mailer.lastMessage?.text ?? '';
  const match = /\b[0-9]{8}\b/.exec(text);
  if (match === null) {
    throw new Error('No eight digit code found in the captured email');
  }
  return match[0];
}

async function apiErrorFrom(action: Promise<unknown>): Promise<ApiError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the action to be refused');
}

beforeAll(async () => {
  db = await createTestDatabase('nimbus_otp');
  redis = await createTestRedis();
  await ensureDatabaseSchema(db.db);
});

afterAll(async () => {
  await redis.cleanup();
  await db.cleanup();
});

beforeEach(async () => {
  await redis.client.flushdb();
  await usersCollection(db.db).deleteMany({});
  await auditEventsCollection(db.db).deleteMany({});
  service = build();
});

describe('asking for a code', () => {
  it('sends one email carrying an eight digit code', async () => {
    const result = await service.requestCode({ email: EMAIL, ip: IP });

    expect(result.requestId).toMatch(/^req_[0-9A-Za-z_-]{21}$/);
    expect(result.expiresInSeconds).toBeGreaterThan(0);
    expect(result.resendAvailableInSeconds).toBe(RESEND_COOLDOWN_SECONDS);
    expect(mailer.sent).toHaveLength(1);
    expect(codeFromLastEmail()).toMatch(/^[0-9]{8}$/);
  });

  it('creates no user, so asking about a stranger reveals nothing', async () => {
    await service.requestCode({ email: 'stranger@example.com', ip: IP });

    expect(await usersCollection(db.db).countDocuments({})).toBe(0);
  });

  it('behaves identically for an address that already has an account', async () => {
    const first = await service.requestCode({ email: EMAIL, ip: IP });
    await service.verifyCode({
      requestId: first.requestId,
      email: EMAIL,
      code: codeFromLastEmail(),
      ip: IP,
    });
    expect(await usersCollection(db.db).countDocuments({})).toBe(1);

    await redis.client.flushdb();
    const known = await service.requestCode({ email: EMAIL, ip: IP });

    await redis.client.flushdb();
    const unknown = await service.requestCode({ email: 'nobody@example.com', ip: IP });

    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(known.expiresInSeconds).toBe(unknown.expiresInSeconds);
    expect(known.resendAvailableInSeconds).toBe(unknown.resendAvailableInSeconds);
  });

  it('normalises the address so one person is one account', async () => {
    await service.requestCode({ email: '  Person@Example.COM ', ip: IP });

    expect(mailer.lastMessage?.to).toBe(EMAIL);
  });

  it('never writes the code to the logs', async () => {
    await service.requestCode({ email: EMAIL, ip: IP });
    const code = codeFromLastEmail();

    expect(JSON.stringify(lines)).not.toContain(code);
  });

  it('records that a code was requested without recording the code', async () => {
    await service.requestCode({ email: EMAIL, ip: IP });
    const code = codeFromLastEmail();

    const events = await auditEventsCollection(db.db).find({}).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('auth.otp.requested');
    expect(JSON.stringify(events)).not.toContain(code);
    expect(JSON.stringify(events)).not.toContain(EMAIL);
  });
});

describe('asking again', () => {
  it('is refused inside the cooldown', async () => {
    await service.requestCode({ email: EMAIL, ip: IP });

    const error = await apiErrorFrom(service.requestCode({ email: EMAIL, ip: IP }));

    expect(error.code).toBe('RATE_LIMITED');
    expect(mailer.sent).toHaveLength(1);
  });

  it('invalidates the previous code once the cooldown passes', async () => {
    const first = await service.requestCode({ email: EMAIL, ip: IP });
    const firstCode = codeFromLastEmail();

    await redis.client.del('nimbus:otp:cooldown:' + (await onlyCooldownKeySuffix()));
    const second = await service.requestCode({ email: EMAIL, ip: IP });
    const secondCode = codeFromLastEmail();

    expect(second.requestId).not.toBe(first.requestId);

    const stale = await apiErrorFrom(
      service.verifyCode({ requestId: first.requestId, email: EMAIL, code: firstCode, ip: IP }),
    );
    expect(stale.code).toBe('OTP_EXPIRED');

    const fresh = await service.verifyCode({
      requestId: second.requestId,
      email: EMAIL,
      code: secondCode,
      ip: IP,
    });
    expect(fresh.user.email).toBe(EMAIL);
  });

  it('refuses once the hourly allowance is gone', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await clearCooldown();
      await service.requestCode({ email: EMAIL, ip: IP });
    }

    await clearCooldown();
    const error = await apiErrorFrom(service.requestCode({ email: EMAIL, ip: IP }));

    expect(error.code).toBe('RATE_LIMITED');
    expect(mailer.sent).toHaveLength(5);
  });

  it('limits one internet address across many different emails', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await service.requestCode({ email: `person${String(attempt)}@example.com`, ip: IP });
    }

    const error = await apiErrorFrom(
      service.requestCode({ email: 'yet-another@example.com', ip: IP }),
    );

    expect(error.code).toBe('RATE_LIMITED');
  });

  it('does not let one address exhaust another address allowance', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await service.requestCode({ email: `person${String(attempt)}@example.com`, ip: IP });
    }

    const other = await service.requestCode({ email: 'elsewhere@example.com', ip: '198.51.100.7' });
    expect(other.requestId).toBeDefined();
  });
});

describe('proving a code', () => {
  it('accepts the right code and creates the account', async () => {
    const { requestId } = await service.requestCode({ email: EMAIL, ip: IP });
    const code = codeFromLastEmail();

    const outcome = await service.verifyCode({ requestId, email: EMAIL, code, ip: IP });

    expect(outcome.created).toBe(true);
    expect(outcome.user.email).toBe(EMAIL);
    expect(outcome.user.authProviders).toEqual(['email_otp']);
    expect(await usersCollection(db.db).countDocuments({})).toBe(1);
  });

  it('reuses the account on a later sign in', async () => {
    const first = await service.requestCode({ email: EMAIL, ip: IP });
    const firstCode = codeFromLastEmail();
    const created = await service.verifyCode({
      requestId: first.requestId,
      email: EMAIL,
      code: firstCode,
      ip: IP,
    });

    await clearCooldown();
    const second = await service.requestCode({ email: EMAIL, ip: IP });
    const secondCode = codeFromLastEmail();
    const returning = await service.verifyCode({
      requestId: second.requestId,
      email: EMAIL,
      code: secondCode,
      ip: IP,
    });

    expect(returning.created).toBe(false);
    expect(returning.user.userId).toBe(created.user.userId);
    expect(await usersCollection(db.db).countDocuments({})).toBe(1);
  });

  it('refuses a wrong code without saying how wrong', async () => {
    const { requestId } = await service.requestCode({ email: EMAIL, ip: IP });
    const code = codeFromLastEmail();
    const wrong = code === '00000000' ? '11111111' : '00000000';

    const error = await apiErrorFrom(
      service.verifyCode({ requestId, email: EMAIL, code: wrong, ip: IP }),
    );

    expect(error.code).toBe('OTP_INVALID');
    expect(error.publicMessage).toBe('That code is not correct.');
    expect(await usersCollection(db.db).countDocuments({})).toBe(0);
  });

  it('refuses a request id that was never issued', async () => {
    const error = await apiErrorFrom(
      service.verifyCode({
        requestId: 'req_aaaaaaaaaaaaaaaaaaaaa',
        email: EMAIL,
        code: '12345678',
        ip: IP,
      }),
    );

    expect(error.code).toBe('OTP_EXPIRED');
  });

  it('refuses a code presented with a different email', async () => {
    const { requestId } = await service.requestCode({ email: EMAIL, ip: IP });
    const code = codeFromLastEmail();

    const error = await apiErrorFrom(
      service.verifyCode({ requestId, email: 'someone-else@example.com', code, ip: IP }),
    );

    expect(error.code).toBe('OTP_INVALID');
    expect(await usersCollection(db.db).countDocuments({})).toBe(0);
  });

  it('refuses a code that is not eight digits', async () => {
    const { requestId } = await service.requestCode({ email: EMAIL, ip: IP });

    const error = await apiErrorFrom(
      service.verifyCode({ requestId, email: EMAIL, code: '123', ip: IP }),
    );

    expect(error.code).toBe('OTP_INVALID');
  });

  it('will not accept the same code twice', async () => {
    const { requestId } = await service.requestCode({ email: EMAIL, ip: IP });
    const code = codeFromLastEmail();

    await service.verifyCode({ requestId, email: EMAIL, code, ip: IP });
    const error = await apiErrorFrom(service.verifyCode({ requestId, email: EMAIL, code, ip: IP }));

    expect(error.code).toBe('OTP_EXPIRED');
    expect(await usersCollection(db.db).countDocuments({})).toBe(1);
  });

  it('lets exactly one of ten simultaneous verifications win', async () => {
    const { requestId } = await service.requestCode({ email: EMAIL, ip: IP });
    const code = codeFromLastEmail();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, async () =>
        service.verifyCode({ requestId, email: EMAIL, code, ip: IP }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await usersCollection(db.db).countDocuments({})).toBe(1);
  });

  it('kills the code after too many wrong guesses', async () => {
    const { requestId } = await service.requestCode({ email: EMAIL, ip: IP });
    const code = codeFromLastEmail();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await apiErrorFrom(service.verifyCode({ requestId, email: EMAIL, code: '00000001', ip: IP }));
    }

    const exhausted = await apiErrorFrom(
      service.verifyCode({ requestId, email: EMAIL, code: '00000001', ip: IP }),
    );
    expect(exhausted.code).toBe('OTP_ATTEMPTS_EXCEEDED');

    const afterwards = await apiErrorFrom(
      service.verifyCode({ requestId, email: EMAIL, code, ip: IP }),
    );
    expect(afterwards.code).toBe('OTP_EXPIRED');
  });

  it('never writes the code or the email to the audit log', async () => {
    const { requestId } = await service.requestCode({ email: EMAIL, ip: IP });
    const code = codeFromLastEmail();
    await service.verifyCode({ requestId, email: EMAIL, code, ip: IP });

    const events = await auditEventsCollection(db.db).find({}).toArray();
    const serialised = JSON.stringify(events);

    expect(events.map((event) => event.action)).toContain('auth.otp.verified');
    expect(serialised).not.toContain(code);
    expect(serialised).not.toContain(EMAIL);
  });

  it('records a rejection when a code is wrong', async () => {
    const { requestId } = await service.requestCode({ email: EMAIL, ip: IP });

    await apiErrorFrom(service.verifyCode({ requestId, email: EMAIL, code: '00000001', ip: IP }));

    const events = await auditEventsCollection(db.db)
      .find({ action: 'auth.otp.rejected' })
      .toArray();

    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe('wrong_code');
    expect(events[0]?.ip).toBe(IP);
  });
});

describe('a disabled account', () => {
  it('cannot sign in even with a valid code', async () => {
    const first = await service.requestCode({ email: EMAIL, ip: IP });
    const firstCode = codeFromLastEmail();
    await service.verifyCode({
      requestId: first.requestId,
      email: EMAIL,
      code: firstCode,
      ip: IP,
    });

    await usersCollection(db.db).updateOne({ email: EMAIL }, { $set: { disabledAt: new Date() } });

    await clearCooldown();
    const second = await service.requestCode({ email: EMAIL, ip: IP });
    const secondCode = codeFromLastEmail();

    const error = await apiErrorFrom(
      service.verifyCode({
        requestId: second.requestId,
        email: EMAIL,
        code: secondCode,
        ip: IP,
      }),
    );

    expect(error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('when email cannot be sent', () => {
  it('reports a provider problem and leaves no unusable code behind', async () => {
    service = build();
    mailer.failNextSends(new Error('smtp is down'));

    const error = await apiErrorFrom(service.requestCode({ email: EMAIL, ip: IP }));

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');

    mailer.stopFailing();
    const retry = await service.requestCode({ email: EMAIL, ip: IP });
    expect(retry.requestId).toBeDefined();
  });
});

async function cooldownKeys(): Promise<string[]> {
  return redis.client.keys('nimbus:otp:cooldown:*');
}

async function clearCooldown(): Promise<void> {
  const keys = await cooldownKeys();
  if (keys.length > 0) {
    await redis.client.del(...keys);
  }
}

async function onlyCooldownKeySuffix(): Promise<string> {
  const keys = await cooldownKeys();
  const first = keys[0];
  if (first === undefined) {
    throw new Error('Expected a cooldown key to exist');
  }
  return first.replace('nimbus:otp:cooldown:', '');
}
