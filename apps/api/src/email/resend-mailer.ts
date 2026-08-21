import type { ResendConfig } from '../config/load.js';
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

export const RESEND_SEND_URL = 'https://api.resend.com/emails';
export const RESEND_TIMEOUT_MS = 15_000;

export interface ResendMailerOptions {
  resend: ResendConfig;
  logger: Logger;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface ResendFailure {
  status: number;
  name: string;
  message: string;
}

export function resendRequest(email: OutgoingEmail, apiKey: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: email.from,
      to: [email.to],
      subject: email.subject,
      text: email.text,
      html: email.html,
    }),
  };
}

export function describeFailure(status: number, payload: unknown): ResendFailure {
  const shape = typeof payload === 'object' && payload !== null ? (payload as ResendFailure) : null;

  return {
    status,
    name: typeof shape?.name === 'string' ? shape.name : 'unknown',
    message: typeof shape?.message === 'string' ? shape.message : 'Resend refused the message.',
  };
}

export class ResendMailer implements Mailer {
  readonly name = 'resend';
  readonly developmentOnly = false;

  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly send0: typeof globalThis.fetch;

  constructor(options: ResendMailerOptions) {
    this.apiKey = options.resend.apiKey;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
    this.send0 = options.fetch ?? globalThis.fetch;
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    assertValidOutgoingEmail(email);

    let response: Response;

    try {
      response = await this.send0(RESEND_SEND_URL, {
        ...resendRequest(email, this.apiKey),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.logger.error(
        { ...describeEmailForLog(email), adapter: this.name, err: redactValue(error) },
        'Could not send an email',
      );

      throw new MailError('MAIL_SEND_FAILED', 'The email could not be sent.', { cause: error });
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const failure = describeFailure(response.status, payload);

      this.logger.error(
        {
          ...describeEmailForLog(email),
          adapter: this.name,
          resendStatus: failure.status,
          resendError: failure.name,
          resendMessage: failure.message,
        },
        'Could not send an email',
      );

      throw new MailError('MAIL_SEND_FAILED', 'The email could not be sent.');
    }

    const id = (payload as { id?: unknown } | null)?.id;

    this.logger.info({ ...describeEmailForLog(email), adapter: this.name }, 'Sent an email');

    return {
      messageId: typeof id === 'string' ? id : 'unknown',
      adapter: this.name,
      delivered: true,
    };
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }
}
