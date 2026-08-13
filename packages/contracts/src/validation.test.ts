import { describe, expect, it } from 'vitest';

import {
  MAX_VALIDATION_FINDINGS,
  PatchValidationReportSchema,
  VALIDATION_FINDING_CODES,
  ValidationFindingSchema,
  type PatchValidationReport,
} from './validation.js';

const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function report(overrides: Partial<Record<keyof PatchValidationReport, unknown>> = {}): unknown {
  return {
    decision: 'allowed',
    baseCommitSha: BASE_SHA,
    changedFiles: 1,
    addedLines: 2,
    removedLines: 1,
    bytes: 240,
    files: [
      {
        path: 'src/app.ts',
        changeKind: 'modified',
        addedLines: 2,
        removedLines: 1,
        protectedPath: false,
      },
    ],
    findings: [],
    approvals: [],
    ...overrides,
  };
}

describe('PatchValidationReportSchema', () => {
  it('accepts a well formed report', () => {
    expect(() => PatchValidationReportSchema.parse(report())).not.toThrow();
  });

  it('rejects an unknown key', () => {
    expect(() =>
      PatchValidationReportSchema.parse({ ...(report() as object), extra: true }),
    ).toThrow();
  });

  it('rejects a base commit that is not a full sha', () => {
    expect(() => PatchValidationReportSchema.parse(report({ baseCommitSha: 'abc' }))).toThrow();
  });

  it('rejects a decision it does not know', () => {
    expect(() => PatchValidationReportSchema.parse(report({ decision: 'maybe' }))).toThrow();
  });

  it('rejects negative counts', () => {
    expect(() => PatchValidationReportSchema.parse(report({ addedLines: -1 }))).toThrow();
  });

  it('rejects more findings than the cap', () => {
    const finding = {
      code: 'PROTECTED_PATH',
      decision: 'approval_required',
      paths: ['package.json'],
      detail: 'a reason',
    };

    expect(() =>
      PatchValidationReportSchema.parse(
        report({
          findings: Array.from({ length: MAX_VALIDATION_FINDINGS + 1 }, () => finding),
        }),
      ),
    ).toThrow();
  });

  it('keeps a hostile path in a finding rather than refusing to describe it', () => {
    expect(() =>
      ValidationFindingSchema.parse({
        code: 'PATH_TRAVERSAL',
        decision: 'denied',
        paths: ['../../etc/passwd'],
        detail: 'A changed path climbs outside the repository.',
      }),
    ).not.toThrow();
  });
});

describe('VALIDATION_FINDING_CODES', () => {
  it('has no duplicates', () => {
    expect(new Set(VALIDATION_FINDING_CODES).size).toBe(VALIDATION_FINDING_CODES.length);
  });

  it('names every code in shouting snake case', () => {
    for (const code of VALIDATION_FINDING_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
    }
  });
});
