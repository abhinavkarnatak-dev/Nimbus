import { describe, expect, it } from 'vitest';

import { createTestLogger, productionConfig, testConfig } from '../http/http.fixtures.js';
import { CapturingMailer } from './capturing-mailer.js';
import { ConsoleMailer, ProductionConsoleMailerError } from './console-mailer.js';
import { MailService, createMailer } from './mail-service.js';
import {
  MailError,
  assertValidOutgoingEmail,
  describeEmailForLog,
  maskEmailAddress,
  senderAddressPart,
  type OutgoingEmail,
} from './mailer.js';
import { escapeHtml, safeLink } from './render.js';
import { pullRequestReadyTemplate } from './templates/pull-request-ready.js';
import { signInCodeTemplate } from './templates/sign-in-code.js';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function validEmail(overrides: Partial<OutgoingEmail> = {}): OutgoingEmail {
  return {
    to: 'person@example.com',
    from: 'Nimbus <noreply@example.com>',
    subject: 'Your Nimbus sign in code',
    text: 'hello',
    html: '<p>hello</p>',
    ...overrides,
  };
}

describe('header injection', () => {
  it('refuses a recipient carrying a newline', () => {
    const attack = `victim@example.com${CR}${LF}Bcc: attacker@evil.com`;

    expect(() => {
      assertValidOutgoingEmail(validEmail({ to: attack }));
    }).toThrow(MailError);
  });

  it('refuses a recipient carrying a bare line feed', () => {
    expect(() => {
      assertValidOutgoingEmail(validEmail({ to: `victim@example.com${LF}Bcc: a@evil.com` }));
    }).toThrow(MailError);
  });

  it('refuses a subject carrying a newline', () => {
    expect(() => {
      assertValidOutgoingEmail(validEmail({ subject: `Hello${CR}${LF}Bcc: attacker@evil.com` }));
    }).toThrow(MailError);
  });

  it('refuses a sender carrying a newline', () => {
    expect(() => {
      assertValidOutgoingEmail(validEmail({ from: `a@example.com${CR}${LF}Bcc: b@evil.com` }));
    }).toThrow(MailError);
  });

  it('reports the reason without echoing the attack back', () => {
    try {
      assertValidOutgoingEmail(validEmail({ to: `victim@example.com${LF}Bcc: a@evil.com` }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MailError);
      expect((error as MailError).code).toBe('MAIL_INVALID_RECIPIENT');
      expect((error as MailError).message).not.toContain('evil.com');
    }
  });
});

describe('address and subject validation', () => {
  it('accepts a well formed message', () => {
    expect(() => {
      assertValidOutgoingEmail(validEmail());
    }).not.toThrow();
  });

  it('accepts a sender with a display name', () => {
    expect(senderAddressPart('Nimbus <noreply@example.com>')).toBe('noreply@example.com');
    expect(senderAddressPart('noreply@example.com')).toBe('noreply@example.com');
  });

  it('refuses an address that is not an address', () => {
    expect(() => {
      assertValidOutgoingEmail(validEmail({ to: 'not-an-address' }));
    }).toThrow(MailError);
  });

  it('refuses an empty subject', () => {
    expect(() => {
      assertValidOutgoingEmail(validEmail({ subject: '   ' }));
    }).toThrow(MailError);
  });

  it('refuses an absurdly long subject', () => {
    expect(() => {
      assertValidOutgoingEmail(validEmail({ subject: 'x'.repeat(500) }));
    }).toThrow(MailError);
  });

  it('refuses an empty body', () => {
    expect(() => {
      assertValidOutgoingEmail(validEmail({ text: '', html: '' }));
    }).toThrow(MailError);
  });
});

describe('escaping', () => {
  it('neutralises a script tag', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes quotes and ampersands, not only angle brackets', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes the ampersand first so entities are not doubled wrongly', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('links in emails', () => {
  it('accepts an ordinary https link', () => {
    expect(safeLink('https://github.com/owner/repo/pull/7')).toContain('https://github.com');
  });

  it('refuses a javascript link', () => {
    expect(safeLink('javascript:alert(1)')).toBeNull();
  });

  it('refuses a data link', () => {
    expect(safeLink('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
  });

  it('refuses something that is not a link at all', () => {
    expect(safeLink('not a url')).toBeNull();
  });
});

describe('the sign in code template', () => {
  it('carries the code in both the text and the html', () => {
    const rendered = signInCodeTemplate.render({ code: '48210375', expiresInMinutes: 10 });

    expect(rendered.text).toContain('48210375');
    expect(rendered.html).toContain('48210375');
    expect(rendered.subject).toBe('Your Nimbus sign in code');
  });

  it('says how long the code lasts and that it is single use', () => {
    const rendered = signInCodeTemplate.render({ code: '48210375', expiresInMinutes: 10 });

    expect(rendered.text).toContain('10 minutes');
    expect(rendered.text).toContain('only be used once');
  });

  it('tells someone who did not ask for it what to do', () => {
    const rendered = signInCodeTemplate.render({ code: '48210375', expiresInMinutes: 10 });

    expect(rendered.text).toContain('you can ignore this email');
  });
});

describe('the pull request template', () => {
  const data = {
    repository: 'octocat/hello-world',
    task: 'Add a <script>alert(1)</script> section',
    branch: 'nimbus/abc-readme',
    pullRequestNumber: 7,
    pullRequestUrl: 'https://github.com/octocat/hello-world/pull/7',
  };

  it('escapes anything a person or repository supplied', () => {
    const rendered = pullRequestReadyTemplate.render(data);

    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('says plainly that nothing was merged', () => {
    const rendered = pullRequestReadyTemplate.render(data);

    expect(rendered.text).toContain('Nothing has been merged');
    expect(rendered.html).toContain('Nothing has been merged');
  });

  it('does not turn an unsafe link into a clickable button', () => {
    const rendered = pullRequestReadyTemplate.render({
      ...data,
      pullRequestUrl: 'javascript:alert(1)',
    });

    expect(rendered.html).not.toContain('javascript:');
  });
});

describe('what reaches the logs', () => {
  it('masks the recipient because an address is personal data', () => {
    expect(maskEmailAddress('abhinav@example.com')).toBe('a***@example.com');
    expect(maskEmailAddress('a@example.com')).toBe('a***@example.com');
    expect(maskEmailAddress('not-an-address')).toBe('***');
  });

  it('describes a message without including its body', () => {
    const described = describeEmailForLog(
      validEmail({ text: 'the code is 48210375', html: '<p>48210375</p>' }),
    );

    expect(JSON.stringify(described)).not.toContain('48210375');
    expect(described['to']).toBe('p***@example.com');
    expect(described['subject']).toBe('Your Nimbus sign in code');
  });
});

describe('the capturing mailer', () => {
  it('keeps the message instead of sending it', async () => {
    const mailer = new CapturingMailer();
    const service = new MailService(mailer, 'Nimbus <noreply@example.com>');

    await service.sendSignInCode('person@example.com', {
      code: '48210375',
      expiresInMinutes: 10,
    });

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.lastMessage?.to).toBe('person@example.com');
    expect(mailer.lastMessage?.text).toContain('48210375');
  });

  it('finds messages sent to one address', async () => {
    const mailer = new CapturingMailer();
    const service = new MailService(mailer, 'Nimbus <noreply@example.com>');

    await service.sendSignInCode('one@example.com', { code: '11111111', expiresInMinutes: 5 });
    await service.sendSignInCode('two@example.com', { code: '22222222', expiresInMinutes: 5 });

    expect(mailer.messagesTo('one@example.com')).toHaveLength(1);
    expect(mailer.messagesTo('two@example.com')[0]?.text).toContain('22222222');
  });

  it('can be told to fail so callers can be tested', async () => {
    const mailer = new CapturingMailer();
    mailer.failNextSends(new Error('provider down'));

    await expect(
      new MailService(mailer, 'Nimbus <noreply@example.com>').sendSignInCode('a@example.com', {
        code: '11111111',
        expiresInMinutes: 5,
      }),
    ).rejects.toThrow('provider down');
  });

  it('still refuses an injected recipient', async () => {
    const mailer = new CapturingMailer();

    await expect(
      mailer.send(validEmail({ to: `a@example.com${LF}Bcc: b@evil.com` })),
    ).rejects.toThrow(MailError);
  });
});

describe('the development mailer', () => {
  it('refuses to exist in production', () => {
    const { logger } = createTestLogger();

    expect(() => new ConsoleMailer({ logger, isProduction: true })).toThrow(
      ProductionConsoleMailerError,
    );
  });

  it('prints the body so you can sign in without an email account', async () => {
    const { logger, lines } = createTestLogger();
    const mailer = new ConsoleMailer({ logger, isProduction: false });

    await mailer.send(validEmail({ text: 'the code is 48210375' }));

    expect(JSON.stringify(lines)).toContain('48210375');
  });

  it('warns once that nothing is actually delivered', async () => {
    const { logger, lines } = createTestLogger();
    const mailer = new ConsoleMailer({ logger, isProduction: false });

    await mailer.send(validEmail());
    await mailer.send(validEmail());

    const warnings = lines.filter((line) => line.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).toContain('never delivered');
  });

  it('reports that it did not deliver', async () => {
    const { logger } = createTestLogger();
    const mailer = new ConsoleMailer({ logger, isProduction: false });

    const result = await mailer.send(validEmail());

    expect(result.delivered).toBe(false);
    expect(mailer.developmentOnly).toBe(true);
  });
});

describe('choosing an adapter', () => {
  it('uses the console adapter when SMTP is not configured', () => {
    const { logger } = createTestLogger();

    const mailer = createMailer({ config: testConfig(), logger });

    expect(mailer.name).toBe('console');
    expect(mailer.developmentOnly).toBe(true);
  });

  it('uses SMTP when it is configured', () => {
    const { logger } = createTestLogger();

    const mailer = createMailer({
      config: testConfig({ SMTP_HOST: 'smtp.example.com' }),
      logger,
    });

    expect(mailer.name).toBe('smtp');
    expect(mailer.developmentOnly).toBe(false);
  });

  it('never picks the development adapter in production', () => {
    const { logger } = createTestLogger();

    const mailer = createMailer({ config: productionConfig(), logger });

    expect(mailer.name).toBe('smtp');
    expect(mailer.developmentOnly).toBe(false);
  });
});
