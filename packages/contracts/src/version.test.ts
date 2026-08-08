import { describe, expect, it } from 'vitest';

import * as contracts from './index.js';
import { CONTRACTS_VERSION, CONTRACTS_WIRE_VERSION } from './version.js';

describe('contracts versioning', () => {
  it('publishes a semantic package version', () => {
    expect(CONTRACTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('publishes a positive integer wire version', () => {
    expect(Number.isInteger(CONTRACTS_WIRE_VERSION)).toBe(true);
    expect(CONTRACTS_WIRE_VERSION).toBeGreaterThan(0);
  });
});

describe('package surface', () => {
  it('re-exports the schemas every boundary needs', () => {
    for (const name of [
      'ApiErrorBodySchema',
      'OtpRequestBodySchema',
      'OtpVerifyBodySchema',
      'MeResponseSchema',
      'RepositoriesResponseSchema',
      'AttachmentMetadataSchema',
      'CreateSessionBodySchema',
      'SessionDetailSchema',
      'SessionListResponseSchema',
      'ApprovalDecisionBodySchema',
      'ServerEventSchema',
      'SessionEventEnvelopeSchema',
      'SubscribeSessionPayloadSchema',
    ]) {
      expect(contracts, `missing export ${name}`).toHaveProperty(name);
    }
  });

  it('exports the limits shared by both sides of every boundary', () => {
    expect(contracts.LIMITS.maxChangedFiles).toBeGreaterThan(0);
    expect(contracts.LIMITS.taskMinChars).toBeLessThan(contracts.LIMITS.taskMaxChars);
  });
});
