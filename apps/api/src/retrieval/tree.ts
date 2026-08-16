import type { WorkspaceEntry } from '../sandbox/index.js';
import { RETRIEVAL_LIMITS } from './limits.js';
import { extensionOf, isRetrievablePath } from './policy.js';

export interface TreeSummary {
  lines: string[];
  text: string;
  directories: number;
  files: number;
  hidden: number;
  truncated: boolean;
}

interface Node {
  name: string;
  directories: Map<string, Node>;
  files: string[];
  count: number;
  extensions: Map<string, number>;
}

function emptyNode(name: string): Node {
  return { name, directories: new Map(), files: [], count: 0, extensions: new Map() };
}

function insert(root: Node, path: string): void {
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? path;
  const extension = extensionOf(path);
  let node = root;

  node.count += 1;
  node.extensions.set(extension, (node.extensions.get(extension) ?? 0) + 1);

  for (const segment of segments.slice(0, -1)) {
    let child = node.directories.get(segment);

    if (child === undefined) {
      child = emptyNode(segment);
      node.directories.set(segment, child);
    }
    node = child;
    node.count += 1;
    node.extensions.set(extension, (node.extensions.get(extension) ?? 0) + 1);
  }
  node.files.push(name);
}

function topExtensions(node: Node): string {
  return [...node.extensions.entries()]
    .filter(([extension]) => extension !== '')
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, RETRIEVAL_LIMITS.treeExtensionsShown)
    .map(([extension]) => extension)
    .join(', ');
}

function countDirectories(node: Node): number {
  let total = node.directories.size;

  for (const child of node.directories.values()) {
    total += countDirectories(child);
  }
  return total;
}

class Renderer {
  readonly lines: string[] = [];

  truncated = false;

  #characters = 0;

  add(text: string): boolean {
    const wouldBe = this.#characters + text.length + 1;

    if (
      this.lines.length >= RETRIEVAL_LIMITS.treeMaxLines ||
      wouldBe > RETRIEVAL_LIMITS.treeMaxChars
    ) {
      this.truncated = true;
      return false;
    }

    this.lines.push(text);
    this.#characters = wouldBe;
    return true;
  }

  walk(node: Node, depth: number): void {
    const indent = '  '.repeat(depth);
    const directories = [...node.directories.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    for (const child of directories) {
      const extensions = topExtensions(child);
      const suffix = extensions === '' ? '' : `  ${extensions}`;
      const label = `${indent}${child.name}/`;
      const noun = child.count === 1 ? 'file' : 'files';

      if (!this.add(`${label.padEnd(40)}${String(child.count)} ${noun}${suffix}`)) {
        return;
      }

      if (depth + 1 >= RETRIEVAL_LIMITS.treeMaxDepth) {
        continue;
      }
      this.walk(child, depth + 1);
    }

    const files = [...node.files].sort((left, right) => left.localeCompare(right));

    if (files.length > RETRIEVAL_LIMITS.treeExpandMaxFiles) {
      this.add(`${indent}${String(files.length)} files here`);
      return;
    }

    for (const file of files) {
      if (!this.add(`${indent}${file}`)) {
        return;
      }
    }
  }
}

export function summarizeTree(entries: readonly WorkspaceEntry[]): TreeSummary {
  const nested = entries
    .filter((entry) => entry.kind === 'repository')
    .map((entry) => `${entry.path}/`);

  const candidates = entries.filter((entry) => entry.kind === 'file');
  const kept = candidates.filter(
    (entry) =>
      isRetrievablePath(entry.path) && !nested.some((prefix) => entry.path.startsWith(prefix)),
  );

  const root = emptyNode('');

  for (const entry of kept) {
    insert(root, entry.path);
  }

  const renderer = new Renderer();
  renderer.walk(root, 0);

  return {
    lines: renderer.lines,
    text: renderer.lines.join('\n'),
    directories: countDirectories(root),
    files: kept.length,
    hidden: candidates.length - kept.length,
    truncated: renderer.truncated,
  };
}
