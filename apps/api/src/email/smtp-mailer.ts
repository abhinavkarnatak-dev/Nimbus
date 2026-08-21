import { createTransport, type Transporter } from 'nodemailer';

import type { SmtpConfig } from '../config/load.js';
import type { Logger } from '../logging/logger.js';
import { redactValue } from '../logging/redact.js';
import {
  MailError,
  assertValidOutgoingEmail,
  describeEmailForLog,
  type Mailer,
  type OutgoingEmail,
  type SendResult,
} from './mailer.js';

export const IP_FAMILY = 4;
export const CONNECTION_TIMEOUT_MS = 10_000;
export const GREETING_TIMEOUT_MS = 10_000;
export const SOCKET_TIMEOUT_MS = 20_000;

export interface SmtpMailerOptions {
  smtp: SmtpConfig;
  logger: Logger;
  requireTls?: boolean;
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
}

interface SmtpErrorShape {
  code?: unknown;
  responseCode?: unknown;
  command?: unknown;
}

function safeErrorFacts(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) {
    return {};
  }
  const shape = error as SmtpErrorShape;
  return {
    ...(typeof shape.code === 'string' ? { smtpErrorCode: shape.code } : {}),
    ...(typeof shape.responseCode === 'number' ? { smtpResponseCode: shape.responseCode } : {}),
    ...(typeof shape.command === 'string' ? { smtpCommand: shape.command } : {}),
  };
}

export function smtpTransportOptions(options: SmtpMailerOptions): Record<string, unknown> {
  const { smtp } = options;

  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    family: IP_FAMILY,
    requireTLS: options.requireTls ?? !smtp.secure,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS,
    greetingTimeout: options.greetingTimeoutMs ?? GREETING_TIMEOUT_MS,
    socketTimeout: options.socketTimeoutMs ?? SOCKET_TIMEOUT_MS,
    ...(smtp.user === undefined || smtp.password === undefined
      ? {}
      : { auth: { user: smtp.user, pass: smtp.password } }),
  };
}

export class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  readonly developmentOnly = false;

  private readonly transporter: Transporter;
  private readonly logger: Logger;

  constructor(options: SmtpMailerOptions) {
    this.logger = options.logger;
    this.transporter = createTransport(smtpTransportOptions(options));
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    assertValidOutgoingEmail(email);

    try {
      const info = (await this.transporter.sendMail({
        to: email.to,
        from: email.from,
        subject: email.subject,
        text: email.text,
        html: email.html,
      })) as { messageId?: unknown };

      this.logger.info({ ...describeEmailForLog(email), adapter: this.name }, 'Sent an email');

      return {
        messageId: typeof info.messageId === 'string' ? info.messageId : 'unknown',
        adapter: this.name,
        delivered: true,
      };
    } catch (error) {
      this.logger.error(
        {
          ...describeEmailForLog(email),
          adapter: this.name,
          ...safeErrorFacts(error),
          err: redactValue(error),
        },
        'Could not send an email',
      );

      throw new MailError('MAIL_SEND_FAILED', 'The email could not be sent.', { cause: error });
    }
  }

  async close(): Promise<void> {
    this.transporter.close();
    await Promise.resolve();
  }
}
