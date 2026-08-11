import { WorkspacePathSchema } from '@nimbus/contracts';

import { SANDBOX_LIMITS } from './limits.js';
import { SandboxError } from './provider.js';

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

  seed(files: Readonly<Record<string, string>>): void {
    for (const [path, contents] of Object.entries(files)) {
      const key = normalizeWorkspacePath(path);
      this.current.set(key, contents);
      this.baseline.set(key, contents);
    }
    this.assertWithinCapacity();
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

  clear(): void {
    this.current.clear();
    this.baseline.clear();
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
