import {
  ToolError,
  applyPatch,
  createFile,
  listTree,
  readFile,
  searchCode,
} from '../../src/agent/tools/index.js';
import { FakeSandboxProvider, buildSandboxSpec, type Sandbox } from '../../src/sandbox/index.js';

const SESSION_ID = 'ses_demodemodemodemodem';

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(34)} ${String(value)}\n`);
}

async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'ALLOWED';
  } catch (error) {
    return error instanceof ToolError ? `refused: ${error.code}` : 'refused: unexpected error';
  }
}

async function makeSandbox(): Promise<Sandbox> {
  const provider = new FakeSandboxProvider({
    files: {
      'README.md': '# Demo\n\nA small repository.\n',
      'src/index.ts': 'import { greet } from "./greet.js";\n\ngreet("world");\n',
      'src/greet.ts': 'export function greet(name: string): string {\n  return `Hi ${name}`;\n}\n',
      'src/auth/login.ts': 'export const login = true;\n',
      'package.json': '{ "name": "demo" }\n',
      '.github/workflows/ci.yml': 'name: ci\n',
      '.env': 'GITHUB_TOKEN=ghs_averyrealisticlookingtokenvalue\n',
      'node_modules/left-pad/index.js': 'module.exports = 1;\n',
      'dist/bundle.js': 'console.log("built");\n',
      'logo.png': `PNG${String.fromCharCode(0)}binarydata`,
      'vendor-lib/main.go': 'package main\n',
    },
    links: {
      'notes.txt': '/etc/passwd',
      assets: '/etc',
      'shortcut.ts': 'src/greet.ts',
    },
    repositories: ['vendor-lib'],
  });

  return await provider.create(
    buildSandboxSpec({ maxSeconds: 60, allowInternet: false, templateId: 'demo' }, SESSION_ID),
  );
}

async function showTree(sandbox: Sandbox): Promise<void> {
  heading('1. What the agent is allowed to see');

  const tree = await listTree(sandbox);

  for (const entry of tree.entries) {
    process.stdout.write(`  ${entry.kind.padEnd(11)} ${entry.path}\n`);
  }

  line('', '');
  line('hidden by policy', tree.hiddenByPolicy);
}

async function showSearch(sandbox: Sandbox): Promise<void> {
  heading('2. Searching, including for something it must never find');

  const found = await searchCode(sandbox, { query: 'greet' });
  line('matches for "greet"', found.matches.length);
  line('first match', `${found.matches[0]?.path ?? '-'}:${String(found.matches[0]?.line ?? 0)}`);

  const secret = await searchCode(sandbox, { query: 'ghs_averyrealisticlookingtokenvalue' });
  line('matches for the token in .env', secret.matches.length);

  const nested = await searchCode(sandbox, { query: 'package main' });
  line('matches inside the nested repo', nested.matches.length);
}

async function showPathTraps(sandbox: Sandbox): Promise<void> {
  heading('3. Every path trap, tried against read_file');

  const traps: [string, string][] = [
    ['an ordinary file', 'src/greet.ts'],
    ['a link that stays inside', 'shortcut.ts'],
    ['a climb out', '../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a link pointing out', 'notes.txt'],
    ['a directory link pointing out', 'assets/passwd'],
    ['inside a nested repository', 'vendor-lib/main.go'],
    ['an environment file', '.env'],
    ['a dependency directory', 'node_modules/left-pad/index.js'],
    ['build output', 'dist/bundle.js'],
    ['a binary file', 'logo.png'],
    ['the git directory', '.git/config'],
  ];

  for (const [label, path] of traps) {
    line(label, await outcome(async () => readFile(sandbox, { path })));
  }
}

async function showProtected(sandbox: Sandbox): Promise<void> {
  heading('4. Protected paths: readable, but flagged');

  for (const path of ['package.json', '.github/workflows/ci.yml', 'src/auth/login.ts']) {
    const result = await readFile(sandbox, { path });
    line(path, `read fine, protected: ${String(result.isProtected)}`);
  }

  const plain = await readFile(sandbox, { path: 'README.md' });
  line('README.md', `read fine, protected: ${String(plain.isProtected)}`);
}

async function showWrites(sandbox: Sandbox): Promise<void> {
  heading('5. Creating and patching');

  const created = await createFile(sandbox, {
    path: 'src/farewell.ts',
    contents: 'export const bye = "bye";\n',
  });
  line('created src/farewell.ts', `${String(created.bytes)} bytes`);

  line(
    'creating it again',
    await outcome(async () => createFile(sandbox, { path: 'src/farewell.ts', contents: 'x' })),
  );

  const good = [
    '--- a/src/greet.ts',
    '+++ b/src/greet.ts',
    '@@ -1,3 +1,3 @@',
    ' export function greet(name: string): string {',
    '-  return `Hi ${name}`;',
    '+  return `Hello ${name}`;',
    ' }',
    '',
  ].join('\n');

  const applied = await applyPatch(sandbox, { patch: good });
  line(
    'patch applied',
    `${String(applied.addedLines)} added, ${String(applied.removedLines)} removed`,
  );
  line('file now says', (await sandbox.readFile('src/greet.ts')).split('\n')[1]?.trim());

  const stale = good.replace('  return `Hi ${name}`;', '  return `Howdy ${name}`;');
  line(
    'a patch whose context moved on',
    await outcome(async () => applyPatch(sandbox, { patch: stale })),
  );

  const deletion = ['--- a/README.md', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-# Demo', ''].join(
    '\n',
  );
  line(
    'a patch that deletes a file',
    await outcome(async () => applyPatch(sandbox, { patch: deletion })),
  );

  const escaping = [
    '--- a/notes.txt',
    '+++ b/notes.txt',
    '@@ -1,1 +1,1 @@',
    '-root',
    '+owned',
    '',
  ].join('\n');
  line(
    'a patch aimed through a link',
    await outcome(async () => applyPatch(sandbox, { patch: escaping })),
  );
}

async function main(): Promise<void> {
  const sandbox = await makeSandbox();

  await showTree(sandbox);
  await showSearch(sandbox);
  await showPathTraps(sandbox);
  await showProtected(sandbox);
  await showWrites(sandbox);

  await sandbox.terminate('completed');
  process.stdout.write('\n');
}

await main();
