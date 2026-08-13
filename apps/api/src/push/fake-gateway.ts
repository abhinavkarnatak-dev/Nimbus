import { PushResultSchema, type PushResult } from '@nimbus/contracts';

import { branchNameFor } from './branch-name.js';
import { PushError, type PushGateway, type PushRequest } from './gateway.js';

export interface FakePushGatewayOptions {
  defaultBranch?: string;
  failWith?: PushError;
}

interface PushedBranch {
  commitSha: string;
  patch: string;
}

function fakeCommitSha(seed: string): string {
  let hash = 0n;
  for (const character of seed) {
    hash = (hash * 31n + BigInt(character.codePointAt(0) ?? 0)) % 16n ** 40n;
  }
  return hash.toString(16).padStart(40, '0').slice(0, 40);
}

export class FakePushGateway implements PushGateway {
  readonly name = 'github-fake';

  readonly requests: PushRequest[] = [];
  readonly branches = new Map<string, PushedBranch>();

  private readonly options: FakePushGatewayOptions;

  constructor(options: FakePushGatewayOptions = {}) {
    this.options = options;
  }

  async push(request: PushRequest): Promise<PushResult> {
    this.requests.push(request);

    if (this.options.failWith !== undefined) {
      throw this.options.failWith;
    }

    if (request.report.decision !== 'allowed') {
      throw new PushError('PUSH_NOT_ALLOWED', 'These changes have not been cleared for pushing.');
    }

    if (request.report.baseCommitSha !== request.baseCommitSha) {
      throw new PushError(
        'PUSH_BASE_MISMATCH',
        'The changes were checked against a different commit.',
      );
    }

    const branch = branchNameFor(request.sessionId, request.task);

    if (branch === (this.options.defaultBranch ?? 'main')) {
      throw new PushError('PUSH_TARGET_FORBIDDEN', 'Nimbus never writes to the default branch.');
    }

    const existing = this.branches.get(branch);

    if (existing !== undefined) {
      if (existing.patch !== request.patch) {
        throw new PushError(
          'PUSH_BRANCH_CONFLICT',
          'That branch already holds different changes and will not be moved.',
        );
      }

      return Promise.resolve(
        PushResultSchema.parse({
          branch,
          commitSha: existing.commitSha,
          outcome: 'already_pushed',
        }),
      );
    }

    const commitSha = fakeCommitSha(`${branch}:${request.patch}`);
    this.branches.set(branch, { commitSha, patch: request.patch });

    return Promise.resolve(PushResultSchema.parse({ branch, commitSha, outcome: 'created' }));
  }
}
