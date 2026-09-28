import { createHash } from 'node:crypto';

import type { AgentState } from '@nimbus/contracts';

import { canonical } from '../policy/hash.js';

function path(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parts: string[] = [];
  for (const one of value.trim().replaceAll('\\', '/').split('/')) {
    if (one === '' || one === '.') continue;
    if (one === '..') parts.pop();
    else parts.push(one);
  }
  return parts.join('/');
}

function whitespace(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

function normalizedArguments(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };

  for (const key of ['path', 'pathPrefix', 'workingDirectory']) {
    if (key in next) next[key] = path(next[key]);
  }
  if ('paths' in next && Array.isArray(next['paths'])) {
    next['paths'] = [...new Set(next['paths'].map(path))].sort();
  }
  if (tool === 'search_code' && 'query' in next) next['query'] = whitespace(next['query']);
  if (tool === 'read_file') {
    next['startLine'] = next['startLine'] ?? 1;
    next['lineCount'] = next['lineCount'] ?? null;
  }
  if ('argv' in next && Array.isArray(next['argv'])) {
    const argv = next['argv'].map((value) => (typeof value === 'string' ? value.trim() : value));
    if (typeof argv[0] === 'string') {
      argv[0] = argv[0].replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? argv[0];
    }
    next['argv'] = argv;
  }
  if ('scope' in next && Array.isArray(next['scope'])) {
    next['scope'] = [...new Set(next['scope'].map(path))].sort();
  }
  return next;
}

export function semanticActionId(
  tool: string,
  input: Record<string, unknown>,
  revision: AgentState['workspaceRevision'],
): string {
  return createHash('sha256')
    .update(canonical({ tool, input: normalizedArguments(tool, input), revision }), 'utf8')
    .digest('hex');
}

export function isCurrentDuplicate(
  state: AgentState,
  tool: string,
  input: Record<string, unknown>,
): boolean {
  const wanted = semanticActionId(tool, input, state.workspaceRevision);
  return state.actions.some(
    (action) => action.semanticId === wanted && action.progress !== 'workspace_change',
  );
}
