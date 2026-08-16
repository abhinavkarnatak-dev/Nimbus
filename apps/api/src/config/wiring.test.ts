import { describe, expect, it } from 'vitest';

import { CommandRunner } from '../agent/commands/runner.js';
import { ToolRegistry } from '../agent/registry/registry.js';
import { parsePatch } from '../agent/tools/patch.js';
import { validatePatch } from '../patch/validator.js';
import { buildPatch } from '../sandbox/diff.js';
import { FakeSandboxProvider } from '../sandbox/fake-provider.js';
import { buildGitPatchExport } from '../sandbox/git-patch.js';
import { testSpec } from '../sandbox/sandbox.fixtures.js';
import { capturingLogger } from '../llm/llm.fixtures.js';
import { DEFAULT_LIMITS, type PatchCaps } from './limits.js';

const BASE_SHA = 'a'.repeat(40);

const TIGHT: PatchCaps = { maxChangedFiles: 2, maxDiffLines: 6 };

function patchFor(count: number): string {
  const sections: string[] = [];

  for (let index = 0; index < count; index += 1) {
    sections.push(
      [
        `--- a/src/file${String(index)}.ts`,
        `+++ b/src/file${String(index)}.ts`,
        '@@ -1,1 +1,1 @@',
        '-const before = 1;',
        '+const after = 1;',
        '',
      ].join('\n'),
    );
  }
  return sections.join('');
}

function gitPatchFor(count: number): string {
  const sections: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const path = `src/file${String(index)}.ts`;
    sections.push(
      [
        `diff --git a/${path} b/${path}`,
        '--- a/' + path,
        '+++ b/' + path,
        '@@ -1,1 +1,1 @@',
        '-const before = 1;',
        '+const after = 1;',
        '',
      ].join('\n'),
    );
  }
  return sections.join('');
}

function mapOf(count: number): Map<string, string> {
  const files = new Map<string, string>();

  for (let index = 0; index < count; index += 1) {
    files.set(`src/file${String(index)}.ts`, `const value = ${String(index)};\n`);
  }
  return files;
}

describe('the trusted validator honours the configured caps', () => {
  it('allows a patch at the configured file limit', () => {
    const report = validatePatch({
      patch: gitPatchFor(2),
      expectedBaseSha: BASE_SHA,
      reportedBaseSha: BASE_SHA,
      limits: TIGHT,
    });

    expect(report.findings.map((finding) => finding.code)).not.toContain('TOO_MANY_FILES');
  });

  it('refuses one file past the configured limit, even though the build allows more', () => {
    const report = validatePatch({
      patch: gitPatchFor(3),
      expectedBaseSha: BASE_SHA,
      reportedBaseSha: BASE_SHA,
      limits: TIGHT,
    });

    expect(report.findings.map((finding) => finding.code)).toContain('TOO_MANY_FILES');
    expect(report.decision).not.toBe('allowed');
    expect(TIGHT.maxChangedFiles).toBeLessThan(DEFAULT_LIMITS.maxChangedFiles);
  });

  it('refuses past the configured line limit', () => {
    const report = validatePatch({
      patch: gitPatchFor(2),
      expectedBaseSha: BASE_SHA,
      reportedBaseSha: BASE_SHA,
      limits: { maxChangedFiles: 10, maxDiffLines: 3 },
    });

    expect(report.findings.map((finding) => finding.code)).toContain('TOO_MANY_LINES');
  });

  it('falls back to the shipped defaults when nothing is passed', () => {
    const report = validatePatch({
      patch: gitPatchFor(3),
      expectedBaseSha: BASE_SHA,
      reportedBaseSha: BASE_SHA,
    });

    expect(report.findings.map((finding) => finding.code)).not.toContain('TOO_MANY_FILES');
  });
});

describe('the patch the model proposes honours the configured caps', () => {
  it('accepts a patch at the limit and refuses one past it', () => {
    expect(parsePatch(patchFor(2), TIGHT)).toHaveLength(2);
    expect(() => parsePatch(patchFor(3), TIGHT)).toThrow();
  });

  it('reaches the tool through the registry rather than a global', async () => {
    const captured = capturingLogger();
    const sandbox = await new FakeSandboxProvider({ files: {} }).create(testSpec());
    const registry = new ToolRegistry({
      sessionId: 'ses_0123456789abcdefghijk',
      sandbox,
      commands: new CommandRunner(sandbox),
      logger: captured.logger,
      limits: TIGHT,
    });

    const result = await registry.invoke({
      toolCallId: 'call_1',
      tool: 'apply_patch',
      input: { patch: gitPatchFor(3) },
    });

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('PATCH_TOO_LARGE');
  });
});

describe('exporting a patch honours the configured caps', () => {
  it('refuses to export more files than the configuration allows', () => {
    expect(() => buildPatch(new Map(), mapOf(2), TIGHT)).not.toThrow();
    expect(() => buildPatch(new Map(), mapOf(3), TIGHT)).toThrow();
  });

  it('refuses to export a git patch past the configured limit', () => {
    expect(() => buildGitPatchExport(gitPatchFor(2), TIGHT)).not.toThrow();
    expect(() => buildGitPatchExport(gitPatchFor(3), TIGHT)).toThrow();
  });

  it('carries the same numbers into the sandbox as into the trusted validator', async () => {
    const spec = testSpec({
      maxChangedFiles: TIGHT.maxChangedFiles,
      maxDiffLines: TIGHT.maxDiffLines,
    });
    const sandbox = await new FakeSandboxProvider({ files: {} }).create(spec);

    await sandbox.writeFile('src/file0.ts', 'const value = 0;\n');
    await sandbox.writeFile('src/file1.ts', 'const value = 1;\n');
    await sandbox.writeFile('src/file2.ts', 'const value = 2;\n');

    await expect(sandbox.exportPatch()).rejects.toThrow();
  });
});

describe('the sandbox output budget comes from the spec', () => {
  it('cuts output at the configured budget rather than the built in one', async () => {
    const spec = testSpec({ maxOutputBytes: 512 });
    const sandbox = await new FakeSandboxProvider({
      files: {},
      commands: { flood: { stdout: 'a'.repeat(4_000) } },
    }).create(spec);

    const result = await sandbox.execute({ argv: ['flood'] });

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(512);
    expect(sandbox.status().outputBytesUsed).toBe(512);
  });
});
