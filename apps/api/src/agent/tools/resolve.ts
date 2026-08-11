import { WorkspacePathSchema } from '@nimbus/contracts';

import type { WorkspaceEntry, WorkspaceEntryKind } from '../../sandbox/index.js';
import { SANDBOX_LIMITS } from '../../sandbox/index.js';
import { ToolError } from './errors.js';
import { TOOL_LIMITS } from './limits.js';
import { isIgnoredPath, isProtectedPath, pathSegments } from './policy-paths.js';

const NUL = String.fromCharCode(0);

export interface ResolvedPath {
  path: string;
  requested: string;
  kind: WorkspaceEntryKind | 'missing';
  followedLinks: number;
  protected: boolean;
}

export function normalizeRequestedPath(requested: string): string {
  if (requested.includes(NUL)) {
    throw new ToolError('PATH_INVALID', 'That path is not usable.', { path: requested });
  }

  const tidied = requested.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
  const parsed = WorkspacePathSchema.safeParse(tidied);

  if (!parsed.success || tidied.endsWith('/') || tidied === '') {
    throw new ToolError('PATH_INVALID', 'That path is not usable.', { path: requested });
  }

  if (pathSegments(tidied).length > TOOL_LIMITS.pathSegmentsMax) {
    throw new ToolError('PATH_INVALID', 'That path is nested too deeply.', { path: requested });
  }

  if (pathSegments(tidied).some((segment) => segment === '.')) {
    throw new ToolError('PATH_INVALID', 'That path is not usable.', { path: requested });
  }
  return parsed.data;
}

function joinAndFlatten(base: string, target: string, requested: string): string {
  const segments = base === '' ? [] : base.split('/');

  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (segments.length === 0) {
        throw new ToolError('PATH_OUTSIDE_WORKSPACE', 'That path leaves the workspace.', {
          path: requested,
        });
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function resolveLinkTarget(target: string, linkPath: string, requested: string): string {
  if (target.startsWith('/')) {
    const root = SANDBOX_LIMITS.workspaceDir;

    if (target === root) {
      return '';
    }

    if (!target.startsWith(`${root}/`)) {
      throw new ToolError('PATH_OUTSIDE_WORKSPACE', 'That path leaves the workspace.', {
        path: requested,
      });
    }
    return joinAndFlatten('', target.slice(root.length + 1), requested);
  }

  const parent = linkPath.split('/').slice(0, -1).join('/');
  return joinAndFlatten(parent, target, requested);
}

export class WorkspaceIndex {
  private readonly entries = new Map<string, WorkspaceEntry>();

  constructor(entries: readonly WorkspaceEntry[]) {
    for (const entry of entries) {
      this.entries.set(entry.path, entry);
    }
  }

  get(path: string): WorkspaceEntry | undefined {
    return this.entries.get(path);
  }

  all(): WorkspaceEntry[] {
    return [...this.entries.values()];
  }

  files(): WorkspaceEntry[] {
    return this.all().filter((entry) => entry.kind === 'file');
  }

  resolve(requested: string): ResolvedPath {
    let path = normalizeRequestedPath(requested);
    let followedLinks = 0;

    for (;;) {
      const jump = this.firstLink(path, requested);

      if (jump === null) {
        break;
      }

      followedLinks += 1;
      if (followedLinks > TOOL_LIMITS.linkHopsMax) {
        throw new ToolError('PATH_LINK_LOOP', 'That path leads round in a circle.', {
          path: requested,
        });
      }
      path = normalizeRequestedPath(jump);
    }

    const entry = this.entries.get(path);
    return {
      path,
      requested,
      kind: entry?.kind ?? 'missing',
      followedLinks,
      protected: isProtectedPath(path),
    };
  }

  private firstLink(path: string, requested: string): string | null {
    const segments = path.split('/');

    for (let depth = 1; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join('/');
      const entry = this.entries.get(prefix);

      if (entry === undefined) {
        continue;
      }

      if (entry.kind === 'repository' && depth < segments.length) {
        throw new ToolError(
          'PATH_NESTED_REPOSITORY',
          'That path is inside a separate repository.',
          { path: requested },
        );
      }

      if (entry.kind === 'symlink') {
        const target = resolveLinkTarget(entry.target ?? '', prefix, requested);
        const rest = segments.slice(depth);
        const joined = [target, ...rest].filter((part) => part !== '').join('/');

        if (joined === '') {
          throw new ToolError('PATH_NOT_A_FILE', 'That path is the workspace root.', {
            path: requested,
          });
        }
        return joined;
      }
    }
    return null;
  }
}

export function assertReadable(resolved: ResolvedPath): void {
  if (isIgnoredPath(resolved.path)) {
    throw new ToolError('PATH_IGNORED', 'That path is not available to the agent.', {
      path: resolved.requested,
    });
  }
}

export function assertRegularFile(resolved: ResolvedPath): void {
  if (resolved.kind === 'missing') {
    throw new ToolError('FILE_NOT_FOUND', 'That file does not exist.', {
      path: resolved.requested,
    });
  }

  if (resolved.kind !== 'file') {
    throw new ToolError('PATH_NOT_A_FILE', 'That path is not a file.', {
      path: resolved.requested,
    });
  }
}

export async function buildIndex(sandbox: {
  listEntries: () => Promise<WorkspaceEntry[]>;
}): Promise<WorkspaceIndex> {
  return new WorkspaceIndex(await sandbox.listEntries());
}
