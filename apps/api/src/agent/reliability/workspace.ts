import { createHash } from 'node:crypto';

import type { WorkspaceRevision } from '@nimbus/contracts';

import type { Sandbox } from '../../sandbox/index.js';

export async function currentWorkspaceRevision(
  sandbox: Sandbox,
  baseCommitSha: string,
  number: number,
): Promise<WorkspaceRevision> {
  const exported = await sandbox.exportPatch();
  return {
    number,
    treeHash: createHash('sha256')
      .update(baseCommitSha)
      .update('\0')
      .update(exported.patch)
      .digest('hex'),
  };
}
