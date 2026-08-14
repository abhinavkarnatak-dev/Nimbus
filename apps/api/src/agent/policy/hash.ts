import { createHash } from 'node:crypto';

import { POLICY_LIMITS } from './limits.js';

export class ActionHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionHashError';
  }
}

export function canonical(value: unknown, depth = 0): string {
  if (depth > POLICY_LIMITS.hashDepthMax) {
    throw new ActionHashError('That action is nested too deeply to hash.');
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`);

    return `{${entries.join(',')}}`;
  }

  throw new ActionHashError('That action holds something that cannot be hashed.');
}

export function actionHash(tool: string, input: unknown): string {
  return createHash('sha256').update(canonical({ tool, input }), 'utf8').digest('hex');
}
