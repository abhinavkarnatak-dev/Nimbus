import { loadConfig } from '../../src/config/load.js';
import { createMailService } from '../../src/email/mail-service.js';
import { GitHubAppTokenProvider } from '../../src/github/token-provider.js';
import { createLogger } from '../../src/logging/logger.js';
import { validatePatch } from '../../src/patch/validator.js';
import { OctokitPullRequestClientFactory } from '../../src/pull-request/octokit-client.js';
import { TrustedPullRequestGateway } from '../../src/pull-request/gateway.js';
import { OctokitGitDataClient, OctokitGitDataFactory } from '../../src/push/octokit-git-data.js';
import { TrustedPushGateway } from '../../src/push/gateway.js';
import { buildPatch } from '../../src/sandbox/diff.js';

const CHANGED_FILE = 'testPackages.py';
const SESSION_ID = `ses_${Date.now().toString(36).padEnd(21, 'x')}`;
const TASK = 'Say which status code the example prints';

function heading(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function line(label: string, value: unknown): void {
  process.stdout.write(`${label.padEnd(32)}${String(value)}\n`);
}

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();

  if (value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env['GITHUB_WRITE_LIVE'] !== '1') {
    process.stdout.write('Set GITHUB_WRITE_LIVE=1 to write to a real repository.\n');
    return;
  }

  const owner = required('LIVE_REPO_OWNER');
  const name = required('LIVE_REPO_NAME');
  const repositoryId = Number(required('LIVE_REPOSITORY_ID'));
  const installationId = Number(required('LIVE_INSTALLATION_ID'));
  const notifyEmail = required('LIVE_NOTIFY_EMAIL');

  const config = loadConfig();
  const logger = createLogger({ level: 'warn', environment: config.env });

  if (config.github === null) {
    throw new Error('GitHub app settings are missing from .env');
  }

  const tokens = new GitHubAppTokenProvider({ github: config.github, logger });
  const mail = createMailService({ config, logger });

  heading('Where this is going');
  line('repository', `${owner}/${name}`);
  line('installation', installationId);

  heading('Reading the repository');
  const readToken = await tokens.getToken({ installationId, repositoryId, scope: 'read' });
  const reader = new OctokitGitDataClient({ owner, name, token: readToken.token });
  const repository = await reader.getRepository();
  const head = await reader.getRef(repository.defaultBranch);

  if (head === null) {
    throw new Error(`the default branch ${repository.defaultBranch} has no commits`);
  }

  const before = await reader.getFile(CHANGED_FILE, head.commitSha);

  if (before === null) {
    throw new Error(`${CHANGED_FILE} is not in that repository`);
  }

  await tokens.revoke(readToken);

  line('default branch', repository.defaultBranch);
  line('base commit', head.commitSha);
  line('file read', `${CHANGED_FILE}, ${String(before.length)} characters`);

  heading('Making a small change');
  const after = before.replace('# prints 200', '# prints 200 when GitHub is reachable');

  if (after === before) {
    throw new Error('the change produced no difference, the file may already be changed');
  }

  const exported = buildPatch(new Map([[CHANGED_FILE, before]]), new Map([[CHANGED_FILE, after]]));

  line('files changed', exported.files.length);
  line('lines', `+${String(exported.addedLines)} -${String(exported.removedLines)}`);

  heading('Judging it (feature 021)');
  const report = validatePatch({
    patch: exported.patch,
    expectedBaseSha: head.commitSha,
    reportedBaseSha: head.commitSha,
  });

  line('decision', report.decision);
  line('findings', report.findings.map((finding) => finding.code).join(', ') || 'none');

  if (report.decision !== 'allowed') {
    process.stdout.write('\nThe change was not cleared, so nothing was written.\n');
    return;
  }

  heading('Pushing the branch (feature 022)');
  const push = new TrustedPushGateway({
    tokens,
    gitData: new OctokitGitDataFactory(),
    logger,
  });

  const pushed = await push.push({
    installationId,
    repositoryId,
    owner,
    name,
    sessionId: SESSION_ID,
    task: TASK,
    baseCommitSha: head.commitSha,
    patch: exported.patch,
    report,
  });

  line('branch', pushed.branch);
  line('commit', pushed.commitSha);
  line('outcome', pushed.outcome);

  heading('Opening the pull request (feature 023)');
  const pullRequests = new TrustedPullRequestGateway({
    tokens,
    clients: new OctokitPullRequestClientFactory(),
    mail,
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
    task: TASK,
    summary: 'Made the comment say when the example prints 200.',
    report,
    checks: [{ name: 'vitest', kind: 'test', status: 'not_run', summary: 'no checks were run' }],
    notifyEmail,
  });

  line('pull request', `#${String(opened.number)}`);
  line('url', opened.url);

  heading('Doing it all again, to prove it is idempotent');
  const pushedAgain = await push.push({
    installationId,
    repositoryId,
    owner,
    name,
    sessionId: SESSION_ID,
    task: TASK,
    baseCommitSha: head.commitSha,
    patch: exported.patch,
    report,
  });

  const openedAgain = await pullRequests.open({
    installationId,
    repositoryId,
    owner,
    name,
    defaultBranch: repository.defaultBranch,
    branch: pushed.branch,
    baseCommitSha: head.commitSha,
    task: TASK,
    summary: 'Made the comment say when the example prints 200.',
    report,
    checks: [{ name: 'vitest', kind: 'test', status: 'not_run', summary: 'no checks were run' }],
    notifyEmail,
  });

  line('second push outcome', pushedAgain.outcome);
  line('same commit', pushedAgain.commitSha === pushed.commitSha);
  line('same pull request', openedAgain.number === opened.number);

  heading('What is left behind');
  line('branch to review or delete', pushed.branch);
  line('pull request', opened.url);
  process.stdout.write('\nNothing was merged. Delete the branch when you are done.\n');

  await mail.close();
}

await main();
