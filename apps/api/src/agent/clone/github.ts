import { Octokit } from '@octokit/rest';

import type { Logger } from '../../logging/logger.js';
import type { Sandbox } from '../../sandbox/index.js';
import { isProbablyText } from '../tools/text.js';
import { CloneError } from './errors.js';
import { CLONE_LIMITS } from './limits.js';
import { planClone, type TreeEntry } from './plan.js';
import type { CloneResult, RepositoryReference, RepositorySource } from './source.js';

const NOT_FOUND = 404;
const QUIET_LOG = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export interface GitHubCloneOptions {
  logger: Logger;
  timeoutMs?: number;
}

export class GitHubRepositorySource implements RepositorySource {
  readonly name = 'github';

  readonly real = true;

  readonly #logger: Logger;

  readonly #timeoutMs: number;

  constructor(options: GitHubCloneOptions) {
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? CLONE_LIMITS.requestTimeoutMs;
  }

  async cloneInto(sandbox: Sandbox, reference: RepositoryReference): Promise<CloneResult> {
    const client = new Octokit({
      auth: reference.token,
      request: { timeout: this.#timeoutMs },
      log: QUIET_LOG,
    });

    const entries = await this.#listTree(client, reference);
    const plan = planClone(entries);
    const written: string[] = [];
    let bytes = 0;

    for (const file of plan.files) {
      const contents = await this.#readBlob(client, reference, file.path);

      if (contents === null) {
        plan.stats.skipped.too_large += 1;
        continue;
      }

      if (!isProbablyText(contents)) {
        plan.stats.skipped.not_text += 1;
        continue;
      }

      await sandbox.writeFile(file.path, contents);
      written.push(file.path);
      bytes += Buffer.byteLength(contents, 'utf8');
    }

    await sandbox.markBaseline();

    const stats = {
      ...plan.stats,
      filesWritten: written.length,
      bytesWritten: bytes,
    };

    const partial = Object.values(stats.skipped).some((count) => count > 0);

    this.#logger.info(
      {
        owner: reference.owner,
        repository: reference.name,
        commitSha: reference.commitSha,
        filesWritten: stats.filesWritten,
        bytesWritten: stats.bytesWritten,
        skipped: stats.skipped,
        partial,
      },
      'a repository was cloned into a sandbox',
    );

    return { commitSha: reference.commitSha, paths: written, stats, partial };
  }

  async #listTree(client: Octokit, reference: RepositoryReference): Promise<TreeEntry[]> {
    try {
      const response = await client.git.getTree({
        owner: reference.owner,
        repo: reference.name,
        tree_sha: reference.commitSha,
        recursive: '1',
      });

      if (response.data.truncated) {
        throw new CloneError(
          'CLONE_TREE_TRUNCATED',
          'That repository is too large to read in one listing.',
          { detail: reference.commitSha },
        );
      }

      return response.data.tree.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      }));
    } catch (error) {
      if (error instanceof CloneError) {
        throw error;
      }

      if (statusOf(error) === NOT_FOUND) {
        throw new CloneError('CLONE_COMMIT_NOT_FOUND', 'That commit is not in that repository.', {
          detail: reference.commitSha,
          cause: error,
        });
      }
      throw new CloneError('CLONE_FAILED', 'That repository could not be read.', { cause: error });
    }
  }

  async #readBlob(
    client: Octokit,
    reference: RepositoryReference,
    path: string,
  ): Promise<string | null> {
    try {
      const response = await client.repos.getContent({
        owner: reference.owner,
        repo: reference.name,
        path,
        ref: reference.commitSha,
      });

      const data = response.data;

      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
        return null;
      }
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
      if (statusOf(error) === NOT_FOUND) {
        return null;
      }
      throw new CloneError('CLONE_FAILED', 'A file could not be read from that repository.', {
        detail: path,
        cause: error,
      });
    }
  }
}
