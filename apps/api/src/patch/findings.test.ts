import { VALIDATION_FINDING_CODES, type ValidationFindingCode } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import {
  APPROVAL_CATEGORY_BY_FINDING,
  FINDING_DECISIONS,
  decisionFor,
  worstDecision,
} from './findings.js';

describe('every finding is accounted for', () => {
  it('gives each code exactly one decision', () => {
    for (const code of VALIDATION_FINDING_CODES) {
      expect(FINDING_DECISIONS[code]).toBeDefined();
    }
  });

  it('does not decide anything for a code that no longer exists', () => {
    const known = new Set<string>(VALIDATION_FINDING_CODES);
    for (const code of Object.keys(FINDING_DECISIONS)) {
      expect(known.has(code)).toBe(true);
    }
  });

  it('gives every approval needing code an approval category', () => {
    for (const code of VALIDATION_FINDING_CODES) {
      if (FINDING_DECISIONS[code] === 'approval_required') {
        expect(APPROVAL_CATEGORY_BY_FINDING[code]).toBeDefined();
      }
    }
  });

  it('never offers an approval category for something refused outright', () => {
    for (const code of Object.keys(APPROVAL_CATEGORY_BY_FINDING) as ValidationFindingCode[]) {
      expect(FINDING_DECISIONS[code]).toBe('approval_required');
    }
  });

  it('never marks a finding as allowed, because a finding is a problem', () => {
    for (const code of VALIDATION_FINDING_CODES) {
      expect(FINDING_DECISIONS[code]).not.toBe('allowed');
    }
  });
});

describe('worstDecision', () => {
  it('allows when there is nothing to say', () => {
    expect(worstDecision([])).toBe('allowed');
  });

  it('prefers approval over allowed', () => {
    expect(worstDecision(['allowed', 'approval_required'])).toBe('approval_required');
  });

  it('prefers denied over everything', () => {
    expect(worstDecision(['approval_required', 'denied', 'allowed'])).toBe('denied');
    expect(worstDecision(['denied', 'allowed'])).toBe('denied');
  });

  it('does not depend on the order it is given', () => {
    expect(worstDecision(['denied', 'approval_required'])).toBe(
      worstDecision(['approval_required', 'denied']),
    );
  });
});

describe('decisionFor', () => {
  it('refuses a symbolic link outright', () => {
    expect(decisionFor('SYMLINK_CHANGE')).toBe('denied');
  });

  it('asks a person about a protected path', () => {
    expect(decisionFor('PROTECTED_PATH')).toBe('approval_required');
  });
});
