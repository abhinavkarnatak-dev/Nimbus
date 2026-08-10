import { EmailSchema } from '@nimbus/contracts';

export const SUBJECT_MAX_CHARS = 200;

const CARRIAGE_RETURN = String.fromCharCode(13);
const LINE_FEED = String.fromCharCode(10);
const NULL_CHARACTER = String.fromCharCode(0);

export interface OutgoingEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  messageId: string;
  adapter: string;
  delivered: boolean;
}

export interface Mailer {
  readonly name: string;
  readonly developmentOnly: boolean;
  send(email: OutgoingEmail): Promise<SendResult>;
  close(): Promise<void>;
}

export const MAIL_ERROR_CODES = [
  'MAIL_INVALID_RECIPIENT',
  'MAIL_INVALID_SENDER',
  'MAIL_INVALID_SUBJECT',
  'MAIL_INVALID_BODY',
  'MAIL_SEND_FAILED',
] as const;

export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

export class MailError extends Error {
  readonly code: MailErrorCode;

  constructor(code: MailErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MailError';
    this.code = code;
  }
}

export function breaksHeaders(value: string): boolean {
  return (
    value.includes(CARRIAGE_RETURN) || value.includes(LINE_FEED) || value.includes(NULL_CHARACTER)
  );
}

export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  return `${address.slice(0, 1)}***@${address.slice(at + 1)}`;
}

export function senderAddressPart(value: string): string {
  const opening = value.lastIndexOf('<');
  const closing = value.lastIndexOf('>');
  if (opening !== -1 && closing > opening) {
    return value.slice(opening + 1, closing).trim();
  }
  return value.trim();
}

export function assertValidOutgoingEmail(email: OutgoingEmail): void {
  if (breaksHeaders(email.to) || !EmailSchema.safeParse(email.to).success) {
    throw new MailError('MAIL_INVALID_RECIPIENT', 'The recipient address is not usable.');
  }

  if (breaksHeaders(email.from) || !EmailSchema.safeParse(senderAddressPart(email.from)).success) {
    throw new MailError('MAIL_INVALID_SENDER', 'The sender address is not usable.');
  }

  if (
    breaksHeaders(email.subject) ||
    email.subject.trim() === '' ||
    email.subject.length > SUBJECT_MAX_CHARS
  ) {
    throw new MailError('MAIL_INVALID_SUBJECT', 'The subject line is not usable.');
  }

  if (email.text.trim() === '' || email.html.trim() === '') {
    throw new MailError('MAIL_INVALID_BODY', 'The message body is empty.');
  }
}

export function describeEmailForLog(email: OutgoingEmail): Record<string, unknown> {
  return {
    to: maskEmailAddress(email.to),
    subject: email.subject,
    bodyBytes: Buffer.byteLength(email.text, 'utf8') + Buffer.byteLength(email.html, 'utf8'),
  };
}
