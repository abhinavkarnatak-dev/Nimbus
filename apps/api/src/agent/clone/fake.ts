import type { Sandbox } from '../../sandbox/index.js';
import { isProbablyText } from '../tools/text.js';
import { CloneError } from './errors.js';
import { planClone, type TreeEntry } from './plan.js';
import { TREE_MODES } from './limits.js';
import type { CloneResult, RepositoryReference, RepositorySource } from './source.js';

export interface FakeRepositoryFile {
  contents: string;
  mode?: string;
  type?: string;
}

export interface FakeRepositoryOptions {
  files: Readonly<Record<string, string | FakeRepositoryFile>>;
  commitSha?: string;
  truncated?: boolean;
  missing?: boolean;
}

function entryFor(path: string, file: string | FakeRepositoryFile): TreeEntry {
  const held = typeof file === 'string' ? { contents: file } : file;

  return {
    path,
    mode: held.mode ?? TREE_MODES.file,
    type: held.type ?? 'blob',
    size: Buffer.byteLength(held.contents, 'utf8'),
  };
}

function contentsOf(file: string | FakeRepositoryFile): string {
  return typeof file === 'string' ? file : file.contents;
}

export class FakeRepositorySource implements RepositorySource {
  readonly name = 'fake';

  readonly real = false;

  readonly calls: RepositoryReference[] = [];

  readonly #options: FakeRepositoryOptions;

  constructor(options: FakeRepositoryOptions) {
    this.#options = options;
  }

  async cloneInto(sandbox: Sandbox, reference: RepositoryReference): Promise<CloneResult> {
    this.calls.push(reference);

    if (this.#options.missing === true) {
      throw new CloneError('CLONE_COMMIT_NOT_FOUND', 'That commit is not in that repository.', {
        detail: reference.commitSha,
      });
    }

    if (this.#options.truncated === true) {
      throw new CloneError(
        'CLONE_TREE_TRUNCATED',
        'That repository is too large to read in one listing.',
        { detail: reference.commitSha },
      );
    }

    const entries = Object.entries(this.#options.files).map(([path, file]) => entryFor(path, file));
    const plan = planClone(entries);
    const written: string[] = [];
    let bytes = 0;

    for (const file of plan.files) {
      const contents = contentsOf(this.#options.files[file.path] ?? '');

      if (!isProbablyText(contents)) {
        plan.stats.skipped.not_text += 1;
        continue;
      }

      await sandbox.writeFile(file.path, contents);
      written.push(file.path);
      bytes += Buffer.byteLength(contents, 'utf8');
    }

    await sandbox.markBaseline();

    const stats = { ...plan.stats, filesWritten: written.length, bytesWritten: bytes };

    return {
      commitSha: reference.commitSha,
      paths: written,
      stats,
      partial: Object.values(stats.skipped).some((count) => count > 0),
    };
  }
}
