import { describe, expect, it } from 'vitest';

import { LIMITS } from './limits.js';
import { checkResultFixture, fileChangeFixture } from './session.fixtures.js';
import {
  CheckResultSchema,
  FileChangeSchema,
  TOOL_NAMES,
  ToolNameSchema,
  WorkspacePathSchema,
} from './tools.js';

describe('workspace paths', () => {
  it('accepts ordinary relative paths', () => {
    for (const path of [
      'README.md',
      'src/index.ts',
      'apps/api/src/agent/graph.ts',
      '.env.example',
    ]) {
      expect(WorkspacePathSchema.safeParse(path).success).toBe(true);
    }
  });

  it('rejects parent directory traversal', () => {
    for (const path of ['../secrets', 'src/../../etc/passwd', 'a/b/../../../c', '..']) {
      expect(WorkspacePathSchema.safeParse(path).success).toBe(false);
    }
  });

  it('rejects absolute POSIX and Windows paths', () => {
    for (const path of ['/etc/passwd', '/root/.ssh/id_rsa', 'C:/Windows/System32', 'D:\\data']) {
      expect(WorkspacePathSchema.safeParse(path).success).toBe(false);
    }
  });

  it('rejects any path reaching into the Git directory', () => {
    for (const path of ['.git/config', 'src/.git/HEAD', '.git']) {
      expect(WorkspacePathSchema.safeParse(path).success).toBe(false);
    }
  });

  it('rejects an empty path and one beyond the length limit', () => {
    expect(WorkspacePathSchema.safeParse('').success).toBe(false);
    expect(WorkspacePathSchema.safeParse('a'.repeat(LIMITS.pathMaxChars + 1)).success).toBe(false);
  });

  it('does not treat a filename containing dots as traversal', () => {
    expect(WorkspacePathSchema.safeParse('src/file..name.ts').success).toBe(true);
    expect(WorkspacePathSchema.safeParse('src/.gitignore').success).toBe(true);
  });
});

describe('file changes', () => {
  it('accepts a modification', () => {
    expect(FileChangeSchema.parse(fileChangeFixture())).toEqual(fileChangeFixture());
  });

  it('accepts a rename carrying the previous path', () => {
    const renamed = {
      ...fileChangeFixture(),
      changeKind: 'renamed' as const,
      previousPath: 'src/utils/date.ts',
    };
    expect(FileChangeSchema.parse(renamed)).toEqual(renamed);
  });

  it('rejects a previous path that escapes the workspace', () => {
    expect(
      FileChangeSchema.safeParse({
        ...fileChangeFixture(),
        changeKind: 'renamed',
        previousPath: '../../etc/passwd',
      }).success,
    ).toBe(false);
  });

  it('rejects negative and fractional line counts', () => {
    expect(FileChangeSchema.safeParse({ ...fileChangeFixture(), addedLines: -1 }).success).toBe(
      false,
    );
    expect(FileChangeSchema.safeParse({ ...fileChangeFixture(), removedLines: 2.5 }).success).toBe(
      false,
    );
  });

  it('rejects an unknown change kind', () => {
    expect(
      FileChangeSchema.safeParse({ ...fileChangeFixture(), changeKind: 'chmod' }).success,
    ).toBe(false);
  });
});

describe('check results', () => {
  it('accepts each defined status', () => {
    for (const status of ['passed', 'failed', 'errored', 'not_run']) {
      expect(CheckResultSchema.safeParse({ ...checkResultFixture(), status }).success).toBe(true);
    }
  });

  it('rejects a status invented to look successful', () => {
    for (const status of ['skipped', 'ok', 'green', 'ignored']) {
      expect(CheckResultSchema.safeParse({ ...checkResultFixture(), status }).success).toBe(false);
    }
  });

  it('rejects an oversized summary', () => {
    expect(
      CheckResultSchema.safeParse({
        ...checkResultFixture(),
        summary: 'x'.repeat(LIMITS.summaryMaxChars + 1),
      }).success,
    ).toBe(false);
  });
});

describe('tool names', () => {
  it('exposes every name through the schema and contains no duplicates', () => {
    for (const name of TOOL_NAMES) {
      expect(ToolNameSchema.safeParse(name).success).toBe(true);
    }
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it('does not expose a push, pull request, secret, or network tool to the agent', () => {
    for (const forbidden of [
      'push_branch',
      'create_pr',
      'read_secret',
      'http_request',
      'query_database',
      'send_email',
    ]) {
      expect(ToolNameSchema.safeParse(forbidden).success).toBe(false);
    }
  });
});
