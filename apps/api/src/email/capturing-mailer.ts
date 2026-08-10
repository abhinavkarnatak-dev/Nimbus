import { newPrefixedId } from '../lib/id.js';
import {
  assertValidOutgoingEmail,
  type Mailer,
  type OutgoingEmail,
  type SendResult,
} from './mailer.js';

export interface CapturedEmail extends OutgoingEmail {
  messageId: string;
  sentAt: Date;
}

export class CapturingMailer implements Mailer {
  readonly name = 'capturing';
  readonly developmentOnly = true;

  private readonly messages: CapturedEmail[] = [];
  private failure: Error | undefined;

  async send(email: OutgoingEmail): Promise<SendResult> {
    assertValidOutgoingEmail(email);

    if (this.failure !== undefined) {
      throw this.failure;
    }

    const messageId = `${newPrefixedId('msg')}@nimbus.test`;
    this.messages.push({ ...email, messageId, sentAt: new Date() });

    await Promise.resolve();
    return { messageId, adapter: this.name, delivered: false };
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }

  get sent(): readonly CapturedEmail[] {
    return this.messages;
  }

  get lastMessage(): CapturedEmail | undefined {
    return this.messages.at(-1);
  }

  messagesTo(address: string): readonly CapturedEmail[] {
    return this.messages.filter((message) => message.to === address);
  }

  failNextSends(error: Error): void {
    this.failure = error;
  }

  stopFailing(): void {
    this.failure = undefined;
  }

  clear(): void {
    this.messages.length = 0;
  }
}
