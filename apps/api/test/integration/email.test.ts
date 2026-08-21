import { startFakeSmtpServer, type FakeSmtpServer } from '@nimbus/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { MailError } from '../../src/email/mailer.js';
import { MailService } from '../../src/email/mail-service.js';
import { SmtpMailer } from '../../src/email/smtp-mailer.js';
import { createTestLogger, type CapturedLog } from '../../src/http/http.fixtures.js';

const SMTP_PASSWORD = 'sup3r-secret-smtp-password';
const SIGN_IN_CODE = '482103';

const servers: FakeSmtpServer[] = [];
const mailers: SmtpMailer[] = [];

afterEach(async () => {
  await Promise.all(mailers.splice(0).map(async (mailer) => mailer.close()));
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

interface Harness {
  service: MailService;
  mailer: SmtpMailer;
  lines: CapturedLog[];
  server: FakeSmtpServer;
}

async function harness(
  behaviour: 'accept' | 'reject-auth' | 'never-greet',
  options: { rejectionMessage?: string; requireTls?: boolean } = {},
): Promise<Harness> {
  const server = await startFakeSmtpServer({
    behaviour,
    ...(options.rejectionMessage === undefined
      ? {}
      : { rejectionMessage: options.rejectionMessage }),
  });
  servers.push(server);

  const { logger, lines } = createTestLogger();
  const mailer = new SmtpMailer({
    smtp: {
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      user: 'nimbus',
      password: SMTP_PASSWORD,
    },
    logger,
    requireTls: options.requireTls ?? false,
    connectionTimeoutMs: 1_500,
    greetingTimeoutMs: 1_500,
    socketTimeoutMs: 2_000,
  });
  mailers.push(mailer);

  return {
    service: new MailService(mailer, 'Nimbus <noreply@example.com>'),
    mailer,
    lines,
    server,
  };
}

describe('sending through a real smtp conversation', () => {
  it('delivers a sign in code and speaks the expected commands', async () => {
    const { service, server } = await harness('accept');

    const result = await service.sendSignInCode('person@example.com', {
      code: SIGN_IN_CODE,
      expiresInMinutes: 10,
    });

    expect(result.delivered).toBe(true);
    expect(result.adapter).toBe('smtp');

    const commands = server.receivedCommands.join(' ').toUpperCase();
    expect(commands).toContain('MAIL FROM');
    expect(commands).toContain('RCPT TO');
    expect(commands).toContain('DATA');
  });

  it('never writes the sign in code to the logs', async () => {
    const { service, lines } = await harness('accept');

    await service.sendSignInCode('person@example.com', {
      code: SIGN_IN_CODE,
      expiresInMinutes: 10,
    });

    expect(JSON.stringify(lines)).not.toContain(SIGN_IN_CODE);
  });

  it('logs the recipient only in masked form', async () => {
    const { service, lines } = await harness('accept');

    await service.sendSignInCode('abhinav@example.com', {
      code: SIGN_IN_CODE,
      expiresInMinutes: 10,
    });

    const logged = JSON.stringify(lines);
    expect(logged).toContain('a***@example.com');
    expect(logged).not.toContain('abhinav@example.com');
  });
});

describe('when the server rejects the login', () => {
  it('fails with a safe error that does not carry the password', async () => {
    const { service } = await harness('reject-auth');

    const attempt = service.sendSignInCode('person@example.com', {
      code: SIGN_IN_CODE,
      expiresInMinutes: 10,
    });

    await expect(attempt).rejects.toBeInstanceOf(MailError);
    await attempt.catch((error: unknown) => {
      const failure = error as MailError;
      expect(failure.code).toBe('MAIL_SEND_FAILED');
      expect(failure.message).not.toContain(SMTP_PASSWORD);
    });
  });

  it('keeps the password out of the logs even when the server echoes it back', async () => {
    const { service, lines } = await harness('reject-auth', {
      rejectionMessage: `535 5.7.8 Rejected credentials user=nimbus password=${SMTP_PASSWORD}`,
    });

    await service
      .sendSignInCode('person@example.com', { code: SIGN_IN_CODE, expiresInMinutes: 10 })
      .catch(() => undefined);

    const logged = JSON.stringify(lines);
    expect(logged).toContain('Could not send an email');
    expect(logged).not.toContain(SMTP_PASSWORD);
  });

  it('still records enough to debug the failure', async () => {
    const { service, lines } = await harness('reject-auth');

    await service
      .sendSignInCode('person@example.com', { code: SIGN_IN_CODE, expiresInMinutes: 10 })
      .catch(() => undefined);

    const logged = JSON.stringify(lines);
    expect(logged).toContain('smtpResponseCode');
    expect(logged).toContain('535');
  });
});

describe('when the server will not encrypt the connection', () => {
  it('refuses to send rather than putting the password on the wire in the clear', async () => {
    const { service } = await harness('accept', { requireTls: true });

    const attempt = service.sendSignInCode('person@example.com', {
      code: SIGN_IN_CODE,
      expiresInMinutes: 10,
    });

    await expect(attempt).rejects.toBeInstanceOf(MailError);
  });

  it('never sends a login attempt to a server that would not encrypt', async () => {
    const { service, server } = await harness('accept', { requireTls: true });

    await service
      .sendSignInCode('person@example.com', { code: SIGN_IN_CODE, expiresInMinutes: 10 })
      .catch(() => undefined);

    const commands = server.receivedCommands.join(' ').toUpperCase();
    expect(commands).not.toContain('AUTH');
    expect(commands).not.toContain('MAIL FROM');
  });
});

describe('when the server accepts a connection and then goes silent', () => {
  it('gives up within the timeout instead of hanging', async () => {
    const { service } = await harness('never-greet');

    const startedAt = Date.now();
    await expect(
      service.sendSignInCode('person@example.com', {
        code: SIGN_IN_CODE,
        expiresInMinutes: 10,
      }),
    ).rejects.toBeInstanceOf(MailError);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(6_000);
    expect(elapsed).toBeGreaterThan(500);
  });
});
