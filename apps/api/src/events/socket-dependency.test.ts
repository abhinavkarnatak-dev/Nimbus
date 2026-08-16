import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const PATCHED_WS = { major: 8, minor: 21, patch: 0 };

function readVersion(text: string): { major: number; minor: number; patch: number } | null {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (parts === null) {
    return null;
  }

  return { major: Number(parts[1]), minor: Number(parts[2]), patch: Number(parts[3]) };
}

function isPatched(text: string): boolean {
  const version = readVersion(text);
  if (version === null) {
    return false;
  }

  if (version.major !== PATCHED_WS.major) {
    return version.major > PATCHED_WS.major;
  }

  if (version.minor !== PATCHED_WS.minor) {
    return version.minor > PATCHED_WS.minor;
  }

  return version.patch >= PATCHED_WS.patch;
}

describe('the websocket dependency', () => {
  it('resolves every ws copy in the lockfile to a patched version', () => {
    const lockfile = readFileSync(`${WORKSPACE_ROOT}pnpm-lock.yaml`, 'utf8');
    const resolved = [...lockfile.matchAll(/^ {2}ws@([^:]+):/gm)].map((match) => match[1] ?? '');

    expect(resolved.length).toBeGreaterThan(0);

    for (const entry of resolved) {
      expect(readVersion(entry), entry).not.toBeNull();
      expect(isPatched(entry), entry).toBe(true);
    }
  });

  it('pins the declared ws dependency to a patched version', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(`${WORKSPACE_ROOT}apps/api/package.json`, 'utf8'),
    );
    const declared = (manifest as { dependencies: Record<string, string> }).dependencies['ws'];

    expect(declared).toBeDefined();
    expect(readVersion(declared ?? '')).not.toBeNull();
    expect(isPatched(declared ?? '')).toBe(true);
  });
});
