import { createHash } from 'node:crypto';

import { RepositoryProfileSchema, type RepositoryProfile } from '@nimbus/contracts';

import type { Sandbox, WorkspaceEntry } from '../../sandbox/index.js';

const MANIFESTS = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'global.json',
]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  py: 'Python', c: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', h: 'C/C++', hpp: 'C++',
  go: 'Go', rs: 'Rust', java: 'Java', cs: 'C#',
};

function dirname(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '.' : path.slice(0, at);
}

function roots(entries: readonly WorkspaceEntry[], pattern: RegExp): string[] {
  return [...new Set(entries.filter((one) => pattern.test(one.path)).map((one) => dirname(one.path)))].sort();
}

export async function buildRepositoryProfile(
  sandbox: Sandbox,
  baseCommitSha: string,
): Promise<RepositoryProfile> {
  const entries = await sandbox.listEntries();
  const files = entries.filter((one) => one.kind === 'file');
  const languages = new Set<string>();
  for (const file of files) {
    const extension = file.path.split('.').at(-1)?.toLowerCase() ?? '';
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (language !== undefined) languages.add(language);
  }
  const manifests = files.filter((one) => MANIFESTS.has(one.path.split('/').at(-1) ?? '')).map((one) => one.path).sort();
  const packageRoots = [...new Set(manifests.map(dirname))].sort();
  const sourceRoots = roots(files, /(?:^|\/)(?:src|lib|app|apps|packages)\//);
  const testRoots = roots(files, /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[^/]+$/);
  const generatedPaths = entries.filter((one) => /(?:^|\/)(?:dist|build|coverage|generated|vendor)\//.test(one.path)).map((one) => one.path).slice(0, 100);
  const frameworks: string[] = [];
  const checkIds: string[] = [];

  for (const manifest of manifests.filter((one) => one.endsWith('package.json'))) {
    try {
      const parsed = JSON.parse(await sandbox.readFile(manifest)) as { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      const dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
      for (const framework of ['react', 'next', 'vite', 'express', 'fastify', 'vitest', '@playwright/test']) {
        if (framework in dependencies) frameworks.push(framework);
      }
      for (const name of Object.keys(parsed.scripts ?? {})) {
        if (/^(test|lint|typecheck|build|format(?::check)?)$/.test(name)) {
          checkIds.push(`${manifest}:${name}`);
        }
      }
    } catch {
      // A malformed manifest remains untrusted repository evidence, not a profiler failure.
    }
  }

  const stable = { baseCommitSha, languages: [...languages].sort(), packageRoots, sourceRoots, testRoots, generatedPaths, manifests, frameworks: [...new Set(frameworks)].sort(), workspaceBoundaries: packageRoots, checkIds: [...new Set(checkIds)].sort() };
  return RepositoryProfileSchema.parse({
    ...stable,
    digest: createHash('sha256').update(JSON.stringify(stable)).digest('hex'),
  });
}
