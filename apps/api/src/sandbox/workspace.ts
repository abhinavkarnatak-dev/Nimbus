import { WorkspacePathSchema } from '@nimbus/contracts';

import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError, type WorkspaceEntry } from './provider.js';

const LINK_TARGET_MAX_CHARS = 1_024;

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim().replace(/^\.\//, '').replace(/\/+/g, '/');
  const parsed = WorkspacePathSchema.safeParse(trimmed);

  if (!parsed.success || trimmed.endsWith('/')) {
    throw new SandboxError('SANDBOX_PATH_INVALID', 'That path is not usable in the workspace.');
  }
  return parsed.data;
}

export class MemoryWorkspace {
  private readonly current = new Map<string, string>();
  private readonly baseline = new Map<string, string>();
  private readonly links = new Map<string, string>();
  private readonly repositories = new Set<string>();

  seed(files: Readonly<Record<string, string>>): void {
    for (const [path, contents] of Object.entries(files)) {
      const key = normalizeWorkspacePath(path);
      this.current.set(key, contents);
      this.baseline.set(key, contents);
    }
    this.assertWithinCapacity();
  }

  seedLinks(links: Readonly<Record<string, string>>): void {
    for (const [path, target] of Object.entries(links)) {
      if (target === '' || target.length > LINK_TARGET_MAX_CHARS) {
        throw new SandboxError('SANDBOX_PATH_INVALID', 'That link target is not usable.');
      }
      this.links.set(normalizeWorkspacePath(path), target);
    }
  }

  seedRepositories(paths: readonly string[]): void {
    for (const path of paths) {
      this.repositories.add(normalizeWorkspacePath(path));
    }
  }

  entries(): WorkspaceEntry[] {
    const found = new Map<string, WorkspaceEntry>();

    for (const path of this.repositories) {
      found.set(path, { path, kind: 'repository', size: 0, target: null });
    }

    for (const [path, target] of this.links) {
      found.set(path, { path, kind: 'symlink', size: 0, target });
    }

    for (const [path, contents] of this.current) {
      if (!found.has(path)) {
        found.set(path, {
          path,
          kind: 'file',
          size: Buffer.byteLength(contents, 'utf8'),
          target: null,
        });
      }
    }

    for (const path of [...found.keys()]) {
      const segments = path.split('/');

      for (let depth = 1; depth < segments.length; depth += 1) {
        const parent = segments.slice(0, depth).join('/');
        if (!found.has(parent)) {
          found.set(parent, { path: parent, kind: 'directory', size: 0, target: null });
        }
      }
    }

    return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  has(path: string): boolean {
    return this.current.has(normalizeWorkspacePath(path));
  }

  read(path: string): string {
    const key = normalizeWorkspacePath(path);
    const contents = this.current.get(key);

    if (contents === undefined) {
      throw new SandboxError('SANDBOX_FILE_NOT_FOUND', 'That file does not exist.');
    }

    if (Buffer.byteLength(contents, 'utf8') > SANDBOX_LIMITS.fileMaxBytes) {
      throw new SandboxError('SANDBOX_FILE_TOO_LARGE', 'That file is too large to read.');
    }
    return contents;
  }

  write(path: string, contents: string): void {
    const key = normalizeWorkspacePath(path);

    if (Buffer.byteLength(contents, 'utf8') > SANDBOX_LIMITS.fileMaxBytes) {
      throw new SandboxError('SANDBOX_FILE_TOO_LARGE', 'That file is too large to write.');
    }

    const previous = this.current.get(key);
    this.current.set(key, contents);

    try {
      this.assertWithinCapacity();
    } catch (error) {
      if (previous === undefined) {
        this.current.delete(key);
      } else {
        this.current.set(key, previous);
      }
      throw error;
    }
  }

  remove(path: string): void {
    const key = normalizeWorkspacePath(path);

    if (!this.current.delete(key)) {
      throw new SandboxError('SANDBOX_FILE_NOT_FOUND', 'That file does not exist.');
    }
  }

  list(): string[] {
    return [...this.current.keys()].sort();
  }

  fileCount(): number {
    return this.current.size;
  }

  usedBytes(): number {
    let total = 0;
    for (const contents of this.current.values()) {
      total += Buffer.byteLength(contents, 'utf8');
    }
    return total;
  }

  snapshot(): { baseline: Map<string, string>; current: Map<string, string> } {
    return { baseline: new Map(this.baseline), current: new Map(this.current) };
  }

  markBaseline(): void {
    this.baseline.clear();

    for (const [path, contents] of this.current) {
      this.baseline.set(path, contents);
    }
  }

  clear(): void {
    this.current.clear();
    this.baseline.clear();
    this.links.clear();
    this.repositories.clear();
  }

  private assertWithinCapacity(): void {
    if (this.current.size > SANDBOX_LIMITS.maxWorkspaceFiles) {
      throw new SandboxError('SANDBOX_WORKSPACE_FULL', 'The workspace holds too many files.');
    }

    if (this.usedBytes() > SANDBOX_LIMITS.maxWorkspaceBytes) {
      throw new SandboxError('SANDBOX_WORKSPACE_FULL', 'The workspace is full.');
    }
  }
}
