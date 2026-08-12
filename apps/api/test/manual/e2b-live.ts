import {
  type E2bSandbox,
  E2bSandboxProvider,
  LiveE2bClient,
  SandboxSweeper,
  buildSandboxSpec,
  ownerQuery,
  type CommandResult,
} from '../../src/sandbox/index.js';

const SESSION_ID = 'ses_livelivelivelivelive';
const API_KEY = process.env['E2B_API_KEY'] ?? '';
const TEMPLATE = process.env['SANDBOX_TEMPLATE_ID'];

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(36)} ${String(value)}\n`);
}

function short(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function report(label: string, result: CommandResult): void {
  line(
    label,
    `${result.outcome} (${String(result.exitCode)}) ${short(result.stdout || result.stderr)}`,
  );
}

if (process.env['E2B_LIVE'] !== '1') {
  process.stdout.write('Set E2B_LIVE=1 to rent a real sandbox. Nothing was done.\n');
  process.exit(0);
}

if (API_KEY === '') {
  process.stdout.write('E2B_API_KEY is not set. Nothing was done.\n');
  process.exit(1);
}

const client = new LiveE2bClient(API_KEY);
const provider = new E2bSandboxProvider(client);
const spec = buildSandboxSpec(
  {
    provider: 'e2b',
    maxSeconds: 300,
    allowInternet: false,
    ...(TEMPLATE === undefined || TEMPLATE === '' ? {} : { templateId: TEMPLATE }),
  },
  SESSION_ID,
);

process.stdout.write('Nimbus feature 019 live check: renting a real E2B sandbox\n');
line('template', spec.templateId);

const started = Date.now();
const sandbox = (await provider.create(spec)) as E2bSandbox;
line('sandbox id', sandbox.sandboxId);
line('created in ms', Date.now() - started);

try {
  heading('1. The machine runs commands');
  report('whoami', await sandbox.execute({ argv: ['whoami'] }));
  report('pwd', await sandbox.execute({ argv: ['pwd'] }));
  report('git version', await sandbox.execute({ argv: ['git', '--version'] }));

  heading('2. Words stay words, with no shell to read them');
  report('echo of a payload', await sandbox.execute({ argv: ['echo', '; touch /tmp/pwned'] }));
  report('did the file appear', await sandbox.execute({ argv: ['ls', '/tmp/pwned'] }));
  report(
    'a quote inside an argument',
    await sandbox.execute({ argv: ['echo', `it${String.fromCharCode(39)}s fine`] }),
  );

  heading('3. The network really is dead');
  report(
    'reach github',
    await sandbox.execute({
      argv: ['curl', '-sS', '-m', '8', 'https://github.com'],
      timeoutMs: 20_000,
    }),
  );
  report(
    'reach the metadata service',
    await sandbox.execute({
      argv: ['curl', '-sS', '-m', '5', 'http://169.254.169.254/'],
      timeoutMs: 15_000,
    }),
  );
  report(
    'resolve a name',
    await sandbox.execute({ argv: ['getent', 'hosts', 'github.com'], timeoutMs: 15_000 }),
  );
  report(
    'reach a private address',
    await sandbox.execute({
      argv: ['curl', '-sS', '-m', '5', 'http://10.0.0.1/'],
      timeoutMs: 15_000,
    }),
  );

  heading('4. The controller cannot be driven from inside');
  report(
    'the health endpoint',
    await sandbox.execute({
      argv: [
        'curl',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-m',
        '5',
        'http://localhost:49983/health',
      ],
      timeoutMs: 15_000,
    }),
  );
  report(
    'listing files through it',
    await sandbox.execute({
      argv: [
        'curl',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-m',
        '5',
        'http://localhost:49983/files?path=/etc/passwd',
      ],
      timeoutMs: 15_000,
    }),
  );
  report(
    'starting a process through it',
    await sandbox.execute({
      argv: [
        'curl',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-m',
        '5',
        '-X',
        'POST',
        '-H',
        'Content-Type: application/json',
        '-d',
        '{}',
        'http://localhost:49983/process.Process/Start',
      ],
      timeoutMs: 15_000,
    }),
  );

  heading('5. No credential is present');
  const leak = await sandbox.execute({ argv: ['env'] });
  line('environment variables', leak.stdout.split('\n').filter((row) => row !== '').length);
  line('holds the e2b key', leak.stdout.includes(API_KEY));
  line('holds anything named token', /token|secret|password/i.test(leak.stdout));

  heading('6. Files and a patch');
  await sandbox.execute({ argv: ['git', 'init', '-q'] });
  await sandbox.execute({ argv: ['git', 'config', 'user.email', 'nimbus@example.com'] });
  await sandbox.execute({ argv: ['git', 'config', 'user.name', 'Nimbus'] });
  await sandbox.writeFile('src/app.ts', 'const a = 1;\nconst b = 2;\n');
  await sandbox.execute({ argv: ['git', 'add', '-A'] });
  await sandbox.execute({ argv: ['git', 'commit', '-q', '-m', 'base'] });

  await sandbox.writeFile('src/app.ts', 'const a = 1;\nconst b = 3;\n');
  await sandbox.writeFile('src/new.ts', 'export const c = 4;\n');

  line('read back', short(await sandbox.readFile('src/app.ts')));
  line('entries seen', (await sandbox.listEntries()).length);

  const exported = await sandbox.exportPatch();
  line('files changed', JSON.stringify(exported.files));
  line(
    'lines added and removed',
    `${String(exported.addedLines)} / ${String(exported.removedLines)}`,
  );
  process.stdout.write(`\n${exported.patch}\n`);

  heading('7. A narrow network window, then closed again');
  const reached = await sandbox.withEgress(['github.com'], 120, async () =>
    sandbox.execute({
      argv: [
        'curl',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-m',
        '15',
        'https://github.com',
      ],
      timeoutMs: 30_000,
    }),
  );
  report('inside the window', reached);
  report(
    'after the window closed',
    await sandbox.execute({
      argv: ['curl', '-sS', '-m', '8', 'https://github.com'],
      timeoutMs: 20_000,
    }),
  );
} finally {
  heading('8. The machine is destroyed');
  await sandbox.terminate('completed');
  line('state', sandbox.status().state);

  const stillRunning = await client.list(ownerQuery());
  line(
    'still listed as running',
    stillRunning.some((found) => found.sandboxId === sandbox.sandboxId),
  );

  const swept = await new SandboxSweeper({ client }).sweepOnce();
  line('sweeper inspected', swept.inspected);
  line('sweeper destroyed', swept.killed);
}
