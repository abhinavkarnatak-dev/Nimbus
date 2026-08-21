import type { CheckResult } from '@nimbus/contracts';

import { validatePatch } from '../patch/validator.js';
import {
  BASE_SHA,
  INSTALLATION_ID,
  REPOSITORY_ID,
  SESSION_ID,
  TASK,
  editPatch,
} from '../push/push.fixtures.js';
import { branchNameFor } from '../push/branch-name.js';
import type { OpenPullRequestRequest } from './gateway.js';

export const SUMMARY = 'Changed the redirect so it keeps the query string.';

export const PASSING_CHECKS: readonly CheckResult[] = [
  { name: 'vitest', kind: 'test', status: 'passed', summary: '12 passed' },
  { name: 'eslint', kind: 'lint', status: 'passed', summary: 'no problems' },
];

export const FAILING_CHECKS: readonly CheckResult[] = [
  { name: 'vitest', kind: 'test', status: 'failed', summary: '2 failed' },
  { name: 'eslint', kind: 'lint', status: 'passed', summary: 'no problems' },
  { name: 'tsc', kind: 'typecheck', status: 'not_run', summary: 'skipped' },
];

export function openRequest(
  overrides: Partial<OpenPullRequestRequest> = {},
): OpenPullRequestRequest {
  const patch = editPatch();

  return {
    installationId: INSTALLATION_ID,
    repositoryId: REPOSITORY_ID,
    owner: 'octocat',
    name: 'hello-world',
    defaultBranch: 'main',
    branch: branchNameFor(SESSION_ID, TASK),
    baseCommitSha: BASE_SHA,
    task: TASK,
    summary: SUMMARY,
    report: validatePatch({ patch, expectedBaseSha: BASE_SHA, reportedBaseSha: BASE_SHA }),
    checks: PASSING_CHECKS,
    ...overrides,
  };
}
