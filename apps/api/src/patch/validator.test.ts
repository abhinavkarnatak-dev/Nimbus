import { LIMITS, PatchValidationReportSchema, type ValidationFindingCode } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import {
  BASE_SHA,
  OTHER_SHA,
  addDiff,
  binaryDiff,
  binaryPatchDiff,
  deleteDiff,
  editDiff,
  manyFiles,
  manyLines,
  modeChangeDiff,
  removedLineDiff,
  renameDiff,
  submoduleDiff,
  symlinkDiff,
} from './patch.fixtures.js';
import { validatePatch } from './validator.js';

function judge(patch: string, reportedBaseSha = BASE_SHA): ReturnType<typeof validatePatch> {
  return validatePatch({ patch, expectedBaseSha: BASE_SHA, reportedBaseSha });
}

function codes(patch: string): ValidationFindingCode[] {
  return judge(patch).findings.map((finding) => finding.code);
}

describe('changes that go straight through', () => {
  it('allows an ordinary edit', () => {
    const report = judge(editDiff());

    expect(report.decision).toBe('allowed');
    expect(report.findings).toHaveLength(0);
    expect(report.changedFiles).toBe(1);
    expect(report.addedLines).toBe(1);
    expect(report.removedLines).toBe(1);
    expect(report.files[0]).toMatchObject({
      path: 'src/app.ts',
      changeKind: 'modified',
      protectedPath: false,
    });
  });

  it('allows a new file', () => {
    const report = judge(addDiff());

    expect(report.decision).toBe('allowed');
    expect(report.files[0]).toMatchObject({ path: 'src/new.ts', changeKind: 'added' });
  });

  it('allows an empty patch', () => {
    const report = judge('');

    expect(report.decision).toBe('allowed');
    expect(report.changedFiles).toBe(0);
  });

  it('allows a secret being taken out', () => {
    const report = judge(
      removedLineDiff('src/app.ts', 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";'),
    );

    expect(report.decision).toBe('allowed');
  });

  it('always produces a report that matches its own schema', () => {
    for (const patch of [editDiff(), deleteDiff(), symlinkDiff(), manyFiles(31)]) {
      expect(() => PatchValidationReportSchema.parse(judge(patch))).not.toThrow();
    }
  });
});

describe('changes that need a person to say yes', () => {
  it('asks before deleting a file', () => {
    const report = judge(deleteDiff());

    expect(report.decision).toBe('approval_required');
    expect(codes(deleteDiff())).toContain('FILE_DELETED');
    expect(report.approvals.map((effect) => effect.category)).toContain('file_deletion');
  });

  it('asks before renaming a file', () => {
    const report = judge(renameDiff());

    expect(report.decision).toBe('approval_required');
    expect(report.files[0]).toMatchObject({
      path: 'src/new.ts',
      previousPath: 'src/old.ts',
      changeKind: 'renamed',
    });
    expect(report.approvals.map((effect) => effect.category)).toContain('file_rename');
  });

  it('asks before touching package.json', () => {
    const report = judge(editDiff('package.json'));

    expect(report.decision).toBe('approval_required');
    expect(report.files[0]?.protectedPath).toBe(true);
    expect(report.approvals.map((effect) => effect.category)).toContain('protected_path_change');
  });

  it('asks before touching a workflow', () => {
    expect(judge(editDiff('.github/workflows/ci.yml')).decision).toBe('approval_required');
  });

  it('asks before touching CODEOWNERS', () => {
    expect(judge(editDiff('CODEOWNERS')).decision).toBe('approval_required');
  });

  it('asks before touching a lockfile', () => {
    expect(judge(editDiff('pnpm-lock.yaml')).decision).toBe('approval_required');
  });

  it('asks before making a file executable', () => {
    const report = judge(modeChangeDiff());

    expect(report.decision).toBe('approval_required');
    expect(codes(modeChangeDiff())).toContain('MODE_CHANGE');
  });

  it('asks when there are more files than the limit', () => {
    const report = judge(manyFiles(LIMITS.maxChangedFiles + 1));

    expect(report.decision).toBe('approval_required');
    expect(report.findings.map((finding) => finding.code)).toContain('TOO_MANY_FILES');
    expect(report.approvals.map((effect) => effect.category)).toContain('oversized_diff');
  });

  it('allows exactly the file limit', () => {
    expect(judge(manyFiles(LIMITS.maxChangedFiles)).decision).toBe('allowed');
  });

  it('asks when there are more lines than the limit', () => {
    const report = judge(manyLines(LIMITS.maxDiffLines + 1));

    expect(report.decision).toBe('approval_required');
    expect(report.findings.map((finding) => finding.code)).toContain('TOO_MANY_LINES');
  });

  it('asks about a long random looking value', () => {
    const report = judge(
      addDiff('src/config.ts', 'const seed = "Zx9Qw3Rt7Yu1Ip4As6Df8Gh0Jk2Lm5Nb";'),
    );

    expect(report.decision).toBe('approval_required');
    expect(report.findings.map((finding) => finding.code)).toContain('HIGH_ENTROPY_STRING');
  });
});

describe('changes that are refused outright', () => {
  const refused: readonly [string, string, ValidationFindingCode][] = [
    ['a path that climbs out', editDiff('../../etc/passwd'), 'PATH_TRAVERSAL'],
    ['an absolute path', editDiff('/etc/passwd'), 'PATH_ABSOLUTE'],
    ['the git directory', editDiff('.git/hooks/pre-commit'), 'PATH_GIT_DIRECTORY'],
    ['a second repository', editDiff('vendor/thing/.git/config'), 'NESTED_REPOSITORY'],
    ['a symbolic link', symlinkDiff(), 'SYMLINK_CHANGE'],
    ['a submodule', submoduleDiff(), 'SUBMODULE_CHANGE'],
    ['a submodule list', editDiff('.gitmodules'), 'SUBMODULE_CHANGE'],
    ['a binary file', binaryDiff(), 'BINARY_FILE'],
    ['a git binary patch', binaryPatchDiff(), 'BINARY_FILE'],
  ];

  for (const [label, patch, code] of refused) {
    it(`refuses ${label}`, () => {
      const report = judge(patch);

      expect(report.decision).toBe('denied');
      expect(report.findings.map((finding) => finding.code)).toContain(code);
      expect(report.approvals).toHaveLength(0);
    });
  }

  it('refuses a patch made from a different commit', () => {
    const report = judge(editDiff(), OTHER_SHA);

    expect(report.decision).toBe('denied');
    expect(report.findings[0]?.code).toBe('BASE_COMMIT_MISMATCH');
    expect(report.changedFiles).toBe(0);
  });

  it('names our commit in the report even when the reported one is wrong', () => {
    expect(judge(editDiff(), OTHER_SHA).baseCommitSha).toBe(BASE_SHA);
  });

  it('refuses something that is not a patch at all', () => {
    const report = judge('hello, this is not a diff');

    expect(report.decision).toBe('denied');
    expect(report.findings[0]?.code).toBe('PATCH_UNREADABLE');
  });

  it('refuses a patch with a header line it cannot read', () => {
    const report = judge(
      ['diff --git a/x.ts b/x.ts', 'wat mode 100644', '--- a/x.ts', '+++ b/x.ts'].join('\n'),
    );

    expect(report.decision).toBe('denied');
  });

  it('refuses a quoted path', () => {
    const report = judge('diff --git "a/x.ts" "b/x.ts"\n');

    expect(report.decision).toBe('denied');
    expect(report.findings[0]?.code).toBe('PATCH_UNREADABLE');
  });

  it('refuses a patch that is too large before trying to read it', () => {
    const report = judge(`${editDiff()}${'\n'.repeat(1_100_000)}`);

    expect(report.decision).toBe('denied');
    expect(report.findings[0]?.code).toBe('PATCH_TOO_LARGE');
  });
});

describe('credentials in added lines', () => {
  const secrets: readonly [string, string][] = [
    ['a github token', 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";'],
    ['a github fine grained token', 'const t = "github_pat_abcdefghijklmnopqrstuvwxyz";'],
    ['an aws key', 'const k = "AKIAIOSFODNN7EXAMPLE";'],
    ['a google key', 'const k = "AIzaSyA1234567890abcdefghijklmnopqrstuv";'],
    ['a slack token', 'const k = "xoxb-1234567890-abcdefghijkl";'],
    ['a stripe key', 'const k = "sk_live_abcdefghij1234567890";'],
    ['a groq key', 'const k = "gsk_abcdefghijklmnopqrstuvwxyz1234";'],
    ['a jwt', 'const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fw";'],
    ['a password in a url', 'const u = "postgres://user:hunter2pass@db/app";'],
    ['a private key block', '-----BEGIN RSA PRIVATE KEY-----'],
    ['an assignment', 'api_key = "abcdefghijklmnopqrst"'],
  ];

  for (const [label, body] of secrets) {
    it(`refuses ${label}`, () => {
      const report = judge(addDiff('src/config.ts', body));

      expect(report.decision).toBe('denied');
      expect(report.findings.map((finding) => finding.code)).toContain('SECRET_DETECTED');
    });
  }

  it('never repeats the credential back in the report', () => {
    const report = judge(
      addDiff('src/config.ts', 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";'),
    );

    expect(JSON.stringify(report)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('several problems at once', () => {
  it('reports every one rather than only the first', () => {
    const report = judge(`${deleteDiff()}${editDiff('package.json')}${symlinkDiff()}`);
    const found = report.findings.map((finding) => finding.code);

    expect(found).toContain('FILE_DELETED');
    expect(found).toContain('PROTECTED_PATH');
    expect(found).toContain('SYMLINK_CHANGE');
  });

  it('never lets an allowed change soften a refusal', () => {
    expect(judge(`${editDiff()}${symlinkDiff()}`).decision).toBe('denied');
  });

  it('never lets an approval soften a refusal', () => {
    expect(judge(`${deleteDiff()}${symlinkDiff()}`).decision).toBe('denied');
  });

  it('counts lines across every file', () => {
    const report = judge(`${editDiff('src/a.ts')}${editDiff('src/b.ts')}`);

    expect(report.changedFiles).toBe(2);
    expect(report.addedLines).toBe(2);
    expect(report.removedLines).toBe(2);
  });
});
