export const BRANCH_PREFIX = 'nimbus';
export const SESSION_CHARS = 8;
export const SLUG_MAX_CHARS = 40;
export const FALLBACK_SLUG = 'task';

const NOT_SLUGGABLE = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

export function slugOf(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(NOT_SLUGGABLE, '-')
    .replace(EDGE_DASHES, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(EDGE_DASHES, '');

  return slug === '' ? FALLBACK_SLUG : slug;
}

export function shortSessionId(sessionId: string): string {
  const body = sessionId.includes('_') ? sessionId.slice(sessionId.indexOf('_') + 1) : sessionId;
  const cleaned = body.toLowerCase().replace(NOT_SLUGGABLE, '');

  return cleaned.slice(0, SESSION_CHARS);
}

export function branchNameFor(sessionId: string, task: string): string {
  return `${BRANCH_PREFIX}/${shortSessionId(sessionId)}-${slugOf(task)}`;
}
