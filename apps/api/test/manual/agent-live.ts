import { Octokit } from '@octokit/rest';

import { GitHubRepositorySource } from '../../src/agent/clone/github.js';
import { ActionExecutor } from '../../src/agent/execute/executor.js';
import { runAgent } from '../../src/agent/graph/run.js';
import { InMemoryApprovals } from '../../src/agent/policy/approvals.js';
import { PolicyGate } from '../../src/agent/policy/policy.js';
import { ToolRegistry } from '../../src/agent/registry/registry.js';
import { CommandRunner } from '../../src/agent/commands/runner.js';
import { createState } from '../../src/agent/state/state.js';
import { loadConfig, type GitHubConfig } from '../../src/config/load.js';
import { createAppJwt } from '../../src/github/app-jwt.js';
import { createMailService } from '../../src/email/mail-service.js';
import { OctokitGitHubDirectory } from '../../src/github/directory.js';
import { toRepositorySummaries } from '../../src/github/repositories.js';
import { GitHubAppTokenProvider } from '../../src/github/token-provider.js';
import { GeminiTextProvider, RoutedTextProvider } from '../../src/llm/index.js';
import { createLogger } from '../../src/logging/logger.js';
import { OctokitPullRequestClientFactory } from '../../src/pull-request/octokit-client.js';
import { TrustedPullRequestGateway } from '../../src/pull-request/gateway.js';
import { OctokitGitDataClient, OctokitGitDataFactory } from '../../src/push/octokit-git-data.js';
import { TrustedPushGateway } from '../../src/push/gateway.js';
import { SessionRouter } from '../../src/routing/router.js';
import { planFor } from '../../src/routing/selection.js';
import {
  E2bSandboxProvider,
  LiveE2bClient,
  buildSandboxSpec,
  type Sandbox,
} from '../../src/sandbox/index.js';

const SESSION_ID = `ses_${Date.now().toString(36).padEnd(21, 'x')}`;
const DEFAULT_TASK =
  'In the string formatting file, add a few more worked examples showing other ways to format a string, each with a short comment saying what it prints';
const DEFAULT_MAX_STEPS = 10;

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(34)} ${String(value)}\n`);
}

function quote(text: string, limit = 60): void {
  for (const one of text.split('\n').slice(0, limit)) {
    process.stdout.write(`    | ${one}\n`);
  }
}

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();

  if (value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function installationFor(github: GitHubConfig, owner: string): Promise<number> {
  const client = new Octokit({
    auth: createAppJwt(github.appId, github.privateKeyPem),
    request: { timeout: 15_000 },
  });

  const response = await client.apps.listInstallations({ per_page: 100 });
  const installations = response.data.map((one) => ({
    id: one.id,
    account: one.account === null ? '' : ((one.account as { login?: string }).login ?? ''),
  }));

  const found = installations.find((one) => one.account.toLowerCase() === owner.toLowerCase());

  if (found === undefined) {
    throw new Error(
      `this app has no installation for ${owner}. It is installed on: ${
        installations.map((one) => `${one.account} (${String(one.id)})`).join(', ') || 'nothing'
      }`,
    );
  }
  return found.id;
}

async function main(): Promise<void> {
  if (process.env['AGENT_LIVE'] !== '1') {
    process.stdout.write(
      'Set AGENT_LIVE=1 to rent a real sandbox, call real models and open a real pull request.\n',
    );
    return;
  }

  const owner = required('LIVE_REPO_OWNER');
  const name = required('LIVE_REPO_NAME');
  const notifyEmail = required('LIVE_NOTIFY_EMAIL');
  const givenInstallation = (process.env['LIVE_INSTALLATION_ID'] ?? '').trim();
  const task = (process.env['LIVE_TASK'] ?? '').trim() || DEFAULT_TASK;
  const askedSteps = Number((process.env['LIVE_MAX_STEPS'] ?? '').trim());
  const maxSteps = Number.isInteger(askedSteps) && askedSteps > 0 ? askedSteps : DEFAULT_MAX_STEPS;

  const config = loadConfig();
  const logger = createLogger({ level: 'warn', environment: config.env });

  if (config.github === null) {
    throw new Error('GitHub app settings are missing from .env');
  }

  const geminiApiKey = (process.env['GEMINI_API_KEY'] ?? '').trim();
  const e2bApiKey = (config.sandbox.apiKey ?? '').trim();
  const chosenModel = (process.env['LIVE_MODEL'] ?? '').trim();
  const chosenLight = (process.env['LIVE_LIGHT_MODEL'] ?? '').trim();

  if (geminiApiKey === '') {
    throw new Error('GEMINI_API_KEY is missing from .env');
  }

  if (e2bApiKey === '') {
    throw new Error('E2B_API_KEY is missing from .env');
  }

  const tokens = new GitHubAppTokenProvider({ github: config.github, logger });

  heading('Finding the installation');
  const installationId =
    givenInstallation === ''
      ? await installationFor(config.github, owner)
      : Number(givenInstallation);

  line('installation', installationId);

  heading('What this is about to do');
  line('repository', `${owner}/${name}`);
  line('task', task);
  line('sandbox', 'a real E2B machine, rented and billed');
  line('models', 'real model calls, charged to whoever owns the key');
  line('steps allowed', maxSteps);
  line('ending', 'a real pull request, if the agent finishes');

  heading('Finding the repository');
  const listingToken = await tokens.getListingToken(installationId);
  const directory = new OctokitGitHubDirectory({ github: config.github, logger });
  const visible = toRepositorySummaries(await directory.listRepositories(listingToken.token));
  const found = visible.find((one) => one.name === name && one.owner === owner);

  await tokens.revoke(listingToken);

  if (found === undefined) {
    throw new Error(
      `${owner}/${name} is not reachable by that installation. It can reach: ${visible
        .map((one) => `${one.owner}/${one.name}`)
        .join(', ')}`,
    );
  }

  const repositoryId = found.repositoryId;
  line('repository id', repositoryId);

  heading('Finding the commit to work from');
  const readToken = await tokens.getToken({ installationId, repositoryId, scope: 'read' });
  const reader = new OctokitGitDataClient({ owner, name, token: readToken.token });
  const repository = await reader.getRepository();
  const head = await reader.getRef(repository.defaultBranch);

  if (head === null) {
    throw new Error(`the default branch ${repository.defaultBranch} has no commits`);
  }

  line('default branch', repository.defaultBranch);
  line('base commit', head.commitSha);

  const providers = [new GeminiTextProvider({ apiKey: geminiApiKey, logger })];

  const text = new RoutedTextProvider({ providers });
  const router = new SessionRouter({
    text,
    logger,
    ...(chosenLight === ''
      ? { ...(chosenModel === '' ? {} : { selection: { textModel: chosenModel } }) }
      : {
          plan: {
            ...planFor(chosenModel === '' ? undefined : { textModel: chosenModel }),
            light: chosenLight,
          },
        }),
  });

  line('primary model', router.modelFor('primary'));
  line('light model', router.modelFor('light'));

  const state = createState({
    sessionId: SESSION_ID,
    userId: 'usr_livelivelivelivelivex',
    repositoryId,
    installationId,
    task,
    baseCommitSha: head.commitSha,
    defaultBranch: repository.defaultBranch,
    models: {
      primary: router.modelFor('primary'),
      light: router.modelFor('light'),
      reasoning: router.modelFor('reasoning'),
      vision: router.modelFor('vision'),
      chosenByUser: false,
    },
    budgets: { maxSteps, maxRetries: 4 },
  });

  heading('Renting a sandbox');
  const sandboxProvider = new E2bSandboxProvider(new LiveE2bClient(e2bApiKey));
  const templateId = (config.sandbox.templateId ?? '').trim();
  const spec = buildSandboxSpec(
    {
      provider: 'e2b',
      maxSeconds: config.sandbox.maxSeconds,
      allowInternet: false,
      ...(templateId === '' ? {} : { templateId }),
    },
    SESSION_ID,
  );

  const started = Date.now();
  const sandbox: Sandbox = await sandboxProvider.create(spec);

  line('sandbox id', sandbox.sandboxId);
  line('ready in ms', Date.now() - started);

  const approvals = new InMemoryApprovals();
  const policy = new PolicyGate({ approvals, logger });
  const registry = new ToolRegistry({
    sessionId: SESSION_ID,
    sandbox,
    commands: new CommandRunner(sandbox),
    logger,
  });

  heading('Running the agent');
  const runStarted = Date.now();

  const result = await runAgent({
    state,
    sandbox,
    registry,
    router,
    executor: new ActionExecutor({ registry, policy, logger }),
    source: new GitHubRepositorySource({ logger }),
    reference: {
      owner,
      name,
      commitSha: head.commitSha,
      token: readToken.token,
    },
    logger,
  });

  await tokens.revoke(readToken);

  line('files cloned in', result.cloned);
  line('steps taken', `${String(result.steps)} of ${String(state.budgets.maxSteps)}`);
  line('ran for', `${String(Math.round((Date.now() - runStarted) / 1000))} seconds`);
  line('phase', result.state.phase);
  line('stop reason', result.state.stopReason ?? 'none');
  line('tokens used', result.state.budgets.llm.tokensUsed);

  heading('What it did, step by step');
  for (const event of result.state.toolEvents) {
    line(`${String(event.step)} ${event.tool}`, `${event.outcome}: ${event.summary}`);
  }

  heading('What it changed');
  line('files changed', result.state.filesChanged.join(', ') || 'none');
  line(
    'checks',
    result.state.checks.map((one) => `${one.name}=${one.status}`).join(', ') || 'none',
  );

  if (result.state.clarificationQuestion !== null) {
    heading('It asked a question and stopped');
    quote(result.state.clarificationQuestion);
    return;
  }

  if (result.state.phase === 'awaiting_approval') {
    heading('It is waiting for a person');
    line('nothing was pushed', 'there is no approval route yet, so this is where it stops');
    return;
  }

  if (result.patch === null || result.report === null) {
    heading('No patch was handed over');
    line('why', result.stopVerdict?.detail ?? 'the run did not reach completion');
    return;
  }

  heading('The patch it handed over');
  line('validator decision', result.report.decision);
  line('changed files', result.report.changedFiles);
  line('lines', `+${String(result.report.addedLines)} -${String(result.report.removedLines)}`);
  line('findings', result.report.findings.map((one) => one.code).join(', ') || 'none');
  quote(result.patch.patch);

  if (result.report.decision !== 'allowed') {
    heading('Not cleared, so nothing was written');
    line('decision', result.report.decision);
    return;
  }

  heading('Pushing the branch');
  const push = new TrustedPushGateway({ tokens, gitData: new OctokitGitDataFactory(), logger });
  const pushed = await push.push({
    installationId,
    repositoryId,
    owner,
    name,
    sessionId: SESSION_ID,
    task,
    baseCommitSha: head.commitSha,
    patch: result.patch.patch,
    report: result.report,
  });

  line('branch', pushed.branch);
  line('commit', pushed.commitSha);

  heading('Opening the pull request');
  const pullRequests = new TrustedPullRequestGateway({
    tokens,
    clients: new OctokitPullRequestClientFactory(),
    mail: createMailService({ config, logger }),
    logger,
  });

  const opened = await pullRequests.open({
    installationId,
    repositoryId,
    owner,
    name,
    defaultBranch: repository.defaultBranch,
    branch: pushed.branch,
    baseCommitSha: head.commitSha,
    task,
    summary: result.patch.summary,
    report: result.report,
    checks: result.state.checks,
    notifyEmail,
  });

  line('pull request', `#${String(opened.number)}`);
  line('url', opened.url);
}

await main();
