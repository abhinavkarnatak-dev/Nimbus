import { createHash } from 'node:crypto';

import { SandboxCapabilitySchema, type SandboxCapability } from '@nimbus/contracts';

import { SANDBOX_LIMITS } from './limits.js';
import type { Sandbox } from './provider.js';

const PROBES: Readonly<Record<string, readonly string[]>> = {
  node: ['node', '--version'], npm: ['npm', '--version'], pnpm: ['pnpm', '--version'], yarn: ['yarn', '--version'],
  python: ['python', '--version'], python3: ['python3', '--version'], gcc: ['gcc', '--version'], gpp: ['g++', '--version'],
  clang: ['clang', '--version'], go: ['go', 'version'], rustc: ['rustc', '--version'], cargo: ['cargo', '--version'],
  java: ['java', '-version'], javac: ['javac', '-version'], maven: ['mvn', '--version'], gradle: ['gradle', '--version'], dotnet: ['dotnet', '--version'],
};

export async function discoverSandboxCapabilities(
  sandbox: Sandbox,
  imageVersion = 'unknown',
): Promise<SandboxCapability> {
  const executables: Record<string, string | null> = {};
  for (const [name, argv] of Object.entries(PROBES)) {
    try {
      const result = await sandbox.execute({ argv, timeoutMs: 5_000 });
      const line = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) ?? '';
      executables[name] = result.outcome === 'succeeded' || result.exitCode === 0 ? line || 'available' : null;
    } catch {
      executables[name] = null;
    }
  }
  const stable = {
    imageVersion,
    executables,
    readableRoots: [SANDBOX_LIMITS.workspaceDir],
    writableRoots: [SANDBOX_LIMITS.workspaceDir, '/tmp'],
    network: 'denied' as const,
    commandTimeoutMs: SANDBOX_LIMITS.maxCommandTimeoutMs,
    outputLimitChars: SANDBOX_LIMITS.outputMaxBytes,
  };
  return SandboxCapabilitySchema.parse({
    ...stable,
    digest: createHash('sha256').update(JSON.stringify(stable)).digest('hex'),
  });
}
