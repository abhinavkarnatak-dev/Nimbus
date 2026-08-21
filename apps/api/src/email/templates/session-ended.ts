import {
  fineParagraph,
  joinLines,
  layout,
  paragraph,
  type EmailTemplate,
  type RenderedEmail,
} from '../render.js';

export interface SessionEndedData {
  repository: string;
  task: string;
  outcome: 'failed' | 'cancelled';
  reason: string;
}

const HEADLINE: Readonly<Record<SessionEndedData['outcome'], string>> = {
  failed: 'Nimbus could not finish that task',
  cancelled: 'That Nimbus session was cancelled',
};

export const sessionEndedTemplate: EmailTemplate<SessionEndedData> = {
  name: 'session-ended',

  render(data: SessionEndedData): RenderedEmail {
    const headline = HEADLINE[data.outcome];

    return {
      subject: `${headline} on ${data.repository}`,
      text: joinLines([
        `${headline}.`,
        '',
        `Repository: ${data.repository}`,
        `Task: ${data.task}`,
        `What happened: ${data.reason}`,
        '',
        'Nothing was pushed and no pull request was opened, so your repository is unchanged.',
        'You can start another session whenever you are ready.',
        '',
        'Nimbus, a cloud coding agent.',
      ]),
      html: layout(headline, 'Nothing was pushed and no pull request was opened.', [
        paragraph(`Repository: ${data.repository}`),
        paragraph(`Task: ${data.task}`),
        paragraph(`What happened: ${data.reason}`),
        fineParagraph(
          'Nothing was pushed and no pull request was opened, so your repository is unchanged. You can start another session whenever you are ready.',
        ),
      ]),
    };
  },
};
