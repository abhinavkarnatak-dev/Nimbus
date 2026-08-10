import { newPrefixedId } from '../lib/id.js';
import type { Logger } from '../logging/logger.js';
import { NEWLINE } from './render.js';
import {
  assertValidOutgoingEmail,
  type Mailer,
  type OutgoingEmail,
  type SendResult,
} from './mailer.js';

export class ProductionConsoleMailerError extends Error {
  constructor() {
    super(
      'The console mailer prints message bodies and must never run in production. Configure SMTP instead.',
    );
    this.name = 'ProductionConsoleMailerError';
  }
}

export interface ConsoleMailerOptions {
  logger: Logger;
  isProduction: boolean;
}

export class ConsoleMailer implements Mailer {
  readonly name = 'console';
  readonly developmentOnly = true;

  private readonly logger: Logger;
  private announced = false;

  constructor(options: ConsoleMailerOptions) {
    if (options.isProduction) {
      throw new ProductionConsoleMailerError();
    }
    this.logger = options.logger;
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    assertValidOutgoingEmail(email);

    if (!this.announced) {
      this.announced = true;
      this.logger.warn(
        { adapter: this.name },
        'Development mailer in use. Emails are printed here and never delivered.',
      );
    }

    const messageId = `${newPrefixedId('msg')}@nimbus.local`;

    this.logger.info(
      {
        adapter: this.name,
        developmentOnly: true,
        to: email.to,
        from: email.from,
        subject: email.subject,
        messageId,
        body: NEWLINE + email.text,
      },
      'Email was not delivered, printed below because SMTP is not configured',
    );

    await Promise.resolve();
    return { messageId, adapter: this.name, delivered: false };
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }
}
