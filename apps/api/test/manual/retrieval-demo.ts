import {
  SAMPLE_LINKS,
  SAMPLE_REPOSITORIES,
  SAMPLE_REPOSITORY,
  SAMPLE_TASK,
} from '../../src/retrieval/retrieval.fixtures.js';
import {
  isRetrievablePath,
  retrieveContext,
  summarizeRetrieval,
  type RetrievalBundle,
} from '../../src/retrieval/index.js';
import { FakeSandboxProvider, buildSandboxSpec, type Sandbox } from '../../src/sandbox/index.js';

const SESSION_ID = 'ses_demodemodemodemodem';

const QUERIES: readonly string[] = [
  SAMPLE_TASK,
  'where do we tokenize source text',
  'how do we total the invoices',
];

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(30)} ${String(value)}\n`);
}

async function makeSandbox(): Promise<Sandbox> {
  const provider = new FakeSandboxProvider({
    files: SAMPLE_REPOSITORY,
    links: SAMPLE_LINKS,
    repositories: SAMPLE_REPOSITORIES,
  });

  return await provider.create(
    buildSandboxSpec(
      { provider: 'fake', maxSeconds: 60, allowInternet: false, templateId: 'demo' },
      SESSION_ID,
    ),
  );
}

function showRanking(bundle: RetrievalBundle): void {
  for (const file of bundle.files) {
    const terms = file.matchedTerms.join(' ');
    process.stdout.write(
      `  ${file.path.padEnd(32)} ${file.score.toFixed(2).padStart(7)}  ${terms}\n`,
    );
  }

  if (bundle.files.length === 0) {
    process.stdout.write('  nothing matched\n');
  }
}

async function main(): Promise<void> {
  const sandbox = await makeSandbox();

  heading('What the repository holds');
  const everything = Object.keys(SAMPLE_REPOSITORY).sort();
  for (const path of everything) {
    const verdict = isRetrievablePath(path) ? 'readable' : 'kept out';
    process.stdout.write(`  ${path.padEnd(38)} ${verdict}\n`);
  }

  const first = await retrieveContext(sandbox, { task: SAMPLE_TASK });

  heading('The tree summary the model is given');
  process.stdout.write(`${first.tree.text}\n`);
  line('directories', first.tree.directories);
  line('files shown', first.tree.files);
  line('files kept out', first.tree.hidden);

  for (const query of QUERIES) {
    const bundle = await retrieveContext(sandbox, { task: query });
    heading(`Query: ${query}`);
    line('terms', bundle.terms.join(', '));
    showRanking(bundle);
  }

  heading('Material that tried to give instructions');
  for (const flag of first.flags) {
    process.stdout.write(`  ${flag.code.padEnd(22)} ${flag.path}:${String(flag.line)}\n`);
  }
  process.stdout.write('  the text itself is never copied into a flag\n');

  heading('What the model actually receives');
  process.stdout.write(`${first.text.slice(0, 1400)}\n`);

  heading('The bundle in numbers');
  const summary = summarizeRetrieval(first);
  line('files seen', summary.stats.filesSeen);
  line('files scanned', summary.stats.filesScanned);
  line('kept out by policy', summary.stats.skippedByPolicy);
  line('skipped, not text', summary.stats.skippedNotText);
  line('bytes scanned', summary.stats.bytesScanned);
  line('characters handed over', summary.characters);
  line('flags', summary.flags.length);

  await sandbox.terminate('completed');
}

await main();
