import { PushResultSchema, type PatchValidationReport, type PushResult } from '@nimbus/contracts';

import { applyPatchToFile, parsePatch, type PatchFile } from '../agent/tools/patch.js';
import type { GitHubTokenProvider, InstallationToken } from '../github/token-provider.js';
import type { Logger } from '../logging/logger.js';
import { alerting } from '../logging/alerts.js';
import { branchNameFor } from './branch-name.js';
import {
  BLOB_MODE,
  type GitDataClient,
  type GitDataFactory,
  type TreeEntryInput,
} from './git-data.js';

export const PUSH_SCOPE = 'push';
export const COMMIT_MESSAGE_MAX_CHARS = 72;

export const PUSH_ERROR_CODES = [
  'PUSH_NOT_ALLOWED',
  'PUSH_BASE_MISMATCH',
  'PUSH_TARGET_FORBIDDEN',
  'PUSH_PATCH_FAILED',
  'PUSH_BRANCH_CONFLICT',
  'PUSH_FAILED',
] as const;

export type PushErrorCode = (typeof PUSH_ERROR_CODES)[number];

export class PushError extends Error {
  readonly code: PushErrorCode;

  constructor(code: PushErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PushError';
    this.code = code;
  }
}

export interface PushRequest {
  installationId: number;
  repositoryId: number;
  owner: string;
  name: string;
  sessionId: string;
  /** Existing PR branch to extend for a follow-up, rather than deriving a new branch from its wording. */
  branch?: string;
  task: string;
  baseCommitSha: string;
  patch: string;
  report: PatchValidationReport;
}

export interface PushGateway {
  readonly name: string;
  push(request: PushRequest): Promise<PushResult>;
}

export interface TrustedPushGatewayOptions {
  tokens: GitHubTokenProvider;
  gitData: GitDataFactory;
  logger?: Logger;
}

interface PreparedFile {
  path: string;
  previousPath: string | null;
  contents: string | null;
}

export function commitMessageFor(task: string): string {
  const single = task.replace(/\s+/g, ' ').trim();
  const trimmed =
    single.length > COMMIT_MESSAGE_MAX_CHARS ? single.slice(0, COMMIT_MESSAGE_MAX_CHARS) : single;

  return trimmed === '' ? 'Apply requested change' : trimmed;
}

function targetPathOf(file: PatchFile): string {
  const path = file.newPath ?? file.oldPath;

  if (path === null || path === '') {
    throw new PushError('PUSH_PATCH_FAILED', 'A change in the patch has no path.');
  }

  return path;
}

export class TrustedPushGateway implements PushGateway {
  readonly name = 'github';

  private readonly options: TrustedPushGatewayOptions;

  constructor(options: TrustedPushGatewayOptions) {
    this.options = options;
  }

  private assertJudged(request: PushRequest): void {
    if (request.report.decision !== 'allowed') {
      throw new PushError('PUSH_NOT_ALLOWED', 'These changes have not been cleared for pushing.');
    }

    if (request.report.baseCommitSha !== request.baseCommitSha) {
      throw new PushError(
        'PUSH_BASE_MISMATCH',
        'The changes were checked against a different commit.',
      );
    }
  }

  private async prepareFiles(client: GitDataClient, request: PushRequest): Promise<PreparedFile[]> {
    let files: PatchFile[];

    try {
      files = parsePatch(request.patch);
    } catch (error) {
      throw new PushError('PUSH_PATCH_FAILED', 'The changes could not be read.', { cause: error });
    }

    const prepared: PreparedFile[] = [];

    for (const file of files) {
      const path = targetPathOf(file);
      const source = file.oldPath;
      const original = source === null ? null : await client.getFile(source, request.baseCommitSha);

      if (file.changeKind === 'deleted') {
        prepared.push({ path, previousPath: source, contents: null });
        continue;
      }

      try {
        prepared.push({
          path,
          previousPath: source === path ? null : source,
          contents: applyPatchToFile(file, original),
        });
      } catch (error) {
        throw new PushError('PUSH_PATCH_FAILED', 'The changes no longer apply cleanly.', {
          cause: error,
        });
      }
    }

    return prepared;
  }

  private async buildTree(
    client: GitDataClient,
    baseTreeSha: string,
    files: readonly PreparedFile[],
  ): Promise<string> {
    const entries: TreeEntryInput[] = [];

    for (const file of files) {
      if (file.previousPath !== null) {
        entries.push({ path: file.previousPath, mode: BLOB_MODE, blobSha: null });
      }

      if (file.contents === null) {
        entries.push({ path: file.path, mode: BLOB_MODE, blobSha: null });
        continue;
      }

      const blobSha = await client.createBlob(file.contents);
      entries.push({ path: file.path, mode: BLOB_MODE, blobSha });
    }

    return client.createTree(baseTreeSha, entries);
  }

  async push(request: PushRequest): Promise<PushResult> {
    this.assertJudged(request);

    const branch = request.branch ?? branchNameFor(request.sessionId, request.task);

    const token: InstallationToken = await this.options.tokens.getToken({
      installationId: request.installationId,
      repositoryId: request.repositoryId,
      scope: PUSH_SCOPE,
    });

    try {
      const client = this.options.gitData.forRepository({
        owner: request.owner,
        name: request.name,
        token: token.token,
      });

      const repository = await client.getRepository();

      if (branch === repository.defaultBranch) {
        throw new PushError('PUSH_TARGET_FORBIDDEN', 'Nimbus never writes to the default branch.');
      }

      const existing = await client.getRef(branch);
      const base = await client.getCommit(request.baseCommitSha);
      const prepared = await this.prepareFiles(client, request);
      const treeSha = await this.buildTree(client, base.treeSha, prepared);

      if (existing !== null) {
        const already = await client.getCommit(existing.commitSha);

        if (already.treeSha === treeSha) {
          return PushResultSchema.parse({
            branch,
            commitSha: existing.commitSha,
            outcome: 'already_pushed',
          });
        }

        if (existing.commitSha !== request.baseCommitSha) {
          throw new PushError(
            'PUSH_BRANCH_CONFLICT',
            'That branch changed after this follow-up started and will not be moved.',
          );
        }

        const commitSha = await client.createCommit({
          message: commitMessageFor(request.task),
          treeSha,
          parentSha: request.baseCommitSha,
        });
        await client.updateRef(branch, commitSha);
        return PushResultSchema.parse({ branch, commitSha, outcome: 'created' });
      }

      const commitSha = await client.createCommit({
        message: commitMessageFor(request.task),
        treeSha,
        parentSha: request.baseCommitSha,
      });

      await client.createRef(branch, commitSha);

      return PushResultSchema.parse({ branch, commitSha, outcome: 'created' });
    } catch (error) {
      if (error instanceof PushError) {
        throw error;
      }
      throw new PushError('PUSH_FAILED', 'The branch could not be pushed.', { cause: error });
    } finally {
      try {
        await this.options.tokens.revoke(token);
      } catch (error) {
        this.options.logger?.warn(
          alerting('push_anomaly', { err: error }),
          'push token could not be revoked',
        );
      }
    }
  }
}
