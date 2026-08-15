import type { AppConfig } from '../config/load.js';
import type { Logger } from '../logging/logger.js';
import { ConsoleMailer } from './console-mailer.js';
import { SmtpMailer } from './smtp-mailer.js';
import type { Mailer, SendResult } from './mailer.js';
import type { EmailTemplate } from './render.js';
import { signInCodeTemplate, type SignInCodeData } from './templates/sign-in-code.js';
import {
  pullRequestReadyTemplate,
  type PullRequestReadyData,
} from './templates/pull-request-ready.js';
import { sessionEndedTemplate, type SessionEndedData } from './templates/session-ended.js';

export interface CreateMailerOptions {
  config: AppConfig;
  logger: Logger;
}

export function createMailer(options: CreateMailerOptions): Mailer {
  const { config, logger } = options;

  if (config.smtp !== null) {
    return new SmtpMailer({ smtp: config.smtp, logger });
  }

  return new ConsoleMailer({ logger, isProduction: config.isProduction });
}

export class MailService {
  private readonly mailer: Mailer;
  private readonly from: string;

  constructor(mailer: Mailer, from: string) {
    this.mailer = mailer;
    this.from = from;
  }

  get adapterName(): string {
    return this.mailer.name;
  }

  get deliversForReal(): boolean {
    return !this.mailer.developmentOnly;
  }

  async sendSignInCode(to: string, data: SignInCodeData): Promise<SendResult> {
    return this.sendTemplate(to, signInCodeTemplate, data);
  }

  async sendPullRequestReady(to: string, data: PullRequestReadyData): Promise<SendResult> {
    return this.sendTemplate(to, pullRequestReadyTemplate, data);
  }

  async sendSessionEnded(to: string, data: SessionEndedData): Promise<SendResult> {
    return this.sendTemplate(to, sessionEndedTemplate, data);
  }

  async close(): Promise<void> {
    await this.mailer.close();
  }

  private async sendTemplate<TData>(
    to: string,
    template: EmailTemplate<TData>,
    data: TData,
  ): Promise<SendResult> {
    const rendered = template.render(data);

    return this.mailer.send({
      to,
      from: this.from,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  }
}

export function createMailService(options: CreateMailerOptions): MailService {
  return new MailService(createMailer(options), options.config.mail.from);
}
