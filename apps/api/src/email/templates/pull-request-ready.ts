import {
  EMAIL_FONT,
  EMAIL_PALETTE,
  escapeHtml,
  fineParagraph,
  joinLines,
  layout,
  paragraph,
  safeLink,
  type EmailTemplate,
  type RenderedEmail,
} from '../render.js';

export interface PullRequestReadyData {
  repository: string;
  task: string;
  branch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

function linkBlock(url: string, label: string): string {
  const href = safeLink(url);
  if (href === null) {
    return paragraph(label);
  }
  return joinLines([
    '<p style="margin:24px 0">',
    `<a href="${href}" style="display:inline-block;padding:12px 20px;background:${EMAIL_PALETTE.markSurface};color:${EMAIL_PALETTE.markText};border-radius:10px;text-decoration:none;font-family:${EMAIL_FONT};font-size:15px;font-weight:600">`,
    escapeHtml(label),
    '</a>',
    '</p>',
  ]);
}

export const pullRequestReadyTemplate: EmailTemplate<PullRequestReadyData> = {
  name: 'pull-request-ready',

  render(data: PullRequestReadyData): RenderedEmail {
    const number = String(data.pullRequestNumber);

    return {
      subject: `Nimbus opened pull request #${number} on ${data.repository}`,
      text: joinLines([
        `Nimbus finished a task on ${data.repository} and opened a pull request for your review.`,
        '',
        `Task: ${data.task}`,
        `Branch: ${data.branch}`,
        `Pull request: #${number}`,
        `Link: ${data.pullRequestUrl}`,
        '',
        'Nothing has been merged. Nimbus never merges pull requests and never writes to the',
        'default branch. Review the changes before merging.',
        '',
        'Nimbus, a cloud coding agent.',
      ]),
      html: layout(
        'Your pull request is ready',
        'Nothing has been merged. Read the diff and decide.',
        [
          paragraph(
            `Nimbus finished a task on ${data.repository} and opened a pull request for your review.`,
          ),
          paragraph(`Task: ${data.task}`),
          paragraph(`Branch: ${data.branch}`),
          linkBlock(data.pullRequestUrl, `Review pull request #${number}`),
          fineParagraph(
            'Nothing has been merged. Nimbus never merges pull requests and never writes to the default branch. Review the changes before merging.',
          ),
        ],
      ),
    };
  },
};
