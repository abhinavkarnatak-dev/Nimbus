import {
  escapeHtml,
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
    '<p style="margin:0 0 20px">',
    `<a href="${href}" style="display:inline-block;padding:10px 18px;background:#1b1f24;color:#ffffff;border-radius:8px;text-decoration:none;font-size:15px">`,
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
      html: layout('Your pull request is ready', [
        paragraph(
          `Nimbus finished a task on ${data.repository} and opened a pull request for your review.`,
        ),
        paragraph(`Task: ${data.task}`),
        paragraph(`Branch: ${data.branch}`),
        linkBlock(data.pullRequestUrl, `Review pull request #${number}`),
        paragraph(
          'Nothing has been merged. Nimbus never merges pull requests and never writes to the default branch. Review the changes before merging.',
        ),
      ]),
    };
  },
};
