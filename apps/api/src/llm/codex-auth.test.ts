import { describe, expect, it } from 'vitest';

import { parseDeviceChallenge } from './codex-auth.js';

describe('Codex device-auth output', () => {
  it('normalizes the canonical device URL and preserves the device code', () => {
    expect(
      parseDeviceChallenge(
        'Open this link: https://auth.openai.com/codex/device\nCode: ab12-CD345',
      ),
    ).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'AB12-CD345',
      expiresAt: null,
    });
  });

  it('does not mistake words such as authorization for a device code', () => {
    expect(
      parseDeviceChallenge('authorization required; open https://chatgpt.com/auth'),
    ).toBeNull();
  });

  it('waits until both the device URL and shaped code are present', () => {
    expect(parseDeviceChallenge('https://auth.openai.com/codex/device')).toBeNull();
    expect(parseDeviceChallenge('Code: ABCD-EFGHI')).toBeNull();
  });
});
