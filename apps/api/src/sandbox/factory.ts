import type { SandboxConfig } from '../config/load.js';
import { E2bSandboxProvider } from './e2b-provider.js';
import { LiveE2bClient } from './e2b-live-client.js';
import { FakeSandboxProvider, type FakeSandboxOptions } from './fake-provider.js';
import { SandboxError, type SandboxProvider } from './provider.js';

export interface SandboxProviderOptions {
  fake?: FakeSandboxOptions;
}

export function createSandboxProvider(
  config: SandboxConfig,
  options: SandboxProviderOptions = {},
): SandboxProvider {
  if (config.provider === 'fake') {
    return new FakeSandboxProvider(options.fake ?? {});
  }

  if (config.apiKey === undefined || config.apiKey.trim() === '') {
    throw new SandboxError(
      'SANDBOX_SPEC_INVALID',
      'The real sandbox provider needs E2B_API_KEY to be set.',
    );
  }

  return new E2bSandboxProvider(new LiveE2bClient(config.apiKey));
}
