import { PullRequestResultSchema, type PullRequestResult } from '@nimbus/contracts';

import { buildPullRequestBody } from './body.js';
import { FIRST_PULL_REQUEST_NUMBER } from './fake-client.js';
import type { OpenPullRequestRequest, PullRequestGateway } from './gateway.js';

export interface FakePullRequestGatewayOptions {
  now?: () => Date;
}

interface OpenedPullRequest {
  number: number;
  url: string;
  body: string;
}

export class FakePullRequestGateway implements PullRequestGateway {
  readonly name = 'github-fake';

  readonly requests: OpenPullRequestRequest[] = [];
  readonly byBranch = new Map<string, OpenedPullRequest>();

  private readonly now: () => Date;

  private nextNumber = FIRST_PULL_REQUEST_NUMBER;

  constructor(options: FakePullRequestGatewayOptions = {}) {
    this.now = options.now ?? ((): Date => new Date());
  }

  async open(request: OpenPullRequestRequest): Promise<PullRequestResult> {
    this.requests.push(request);

    const existing = this.byBranch.get(request.branch);

    if (existing !== undefined) {
      return Promise.resolve(
        PullRequestResultSchema.parse({
          number: existing.number,
          url: existing.url,
          branch: request.branch,
          headSha: 'b'.repeat(40),
          createdAt: this.now().toISOString(),
        }),
      );
    }

    const number = this.nextNumber;
    this.nextNumber += 1;

    const opened: OpenedPullRequest = {
      number,
      url: `https://github.com/${request.owner}/${request.name}/pull/${String(number)}`,
      body: buildPullRequestBody({
        task: request.task,
        summary: request.summary,
        branch: request.branch,
        baseCommitSha: request.baseCommitSha,
        report: request.report,
        checks: request.checks,
      }),
    };

    this.byBranch.set(request.branch, opened);

    return Promise.resolve(
      PullRequestResultSchema.parse({
        number,
        url: opened.url,
        branch: request.branch,
        headSha: 'b'.repeat(40),
        createdAt: this.now().toISOString(),
      }),
    );
  }
}
