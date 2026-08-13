import type { PatchValidationReport } from '@nimbus/contracts';

import { validatePatch } from '../patch/validator.js';
import type { PushRequest } from './gateway.js';

export const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const INSTALLATION_ID = 152_851_946;
export const REPOSITORY_ID = 987_654;
export const SESSION_ID = 'ses_V1StGXR8Z5jdHi6BmyTab';
export const TASK = 'Fix the broken login redirect';

export const BASE_FILES: Readonly<Record<string, string>> = {
  'src/app.ts': 'const a = 1;\nconst b = 2;\n',
  'src/old.ts': 'export const d = 5;\n',
};

export function editPatch(path = 'src/app.ts'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 83db48f..bf269f4 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '',
  ].join('\n');
}

export function addPatch(path = 'src/new.ts', body = 'export const c = 4;'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1234567',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${body}`,
    '',
  ].join('\n');
}

export function unmatchedPatch(path = 'src/app.ts'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 83db48f..bf269f4 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    ' something that is not in the file',
    '-const b = 2;',
    '+const b = 3;',
    '',
  ].join('\n');
}

export function reportFor(patch: string, baseCommitSha = BASE_SHA): PatchValidationReport {
  return validatePatch({ patch, expectedBaseSha: baseCommitSha, reportedBaseSha: baseCommitSha });
}

export function pushRequest(overrides: Partial<PushRequest> = {}): PushRequest {
  const patch = overrides.patch ?? editPatch();

  return {
    installationId: INSTALLATION_ID,
    repositoryId: REPOSITORY_ID,
    owner: 'octocat',
    name: 'hello-world',
    sessionId: SESSION_ID,
    task: TASK,
    baseCommitSha: BASE_SHA,
    patch,
    report: reportFor(patch),
    ...overrides,
  };
}
