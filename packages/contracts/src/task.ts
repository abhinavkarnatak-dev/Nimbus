export const TASK_MIN_CHARS = 15;
export const TASK_MIN_WORDS = 4;

export const TASK_FILLER_WORDS: ReadonlySet<string> = new Set([
  'fix',
  'it',
  'this',
  'that',
  'the',
  'a',
  'an',
  'please',
  'thing',
  'stuff',
  'code',
  'app',
  'project',
  'everything',
  'anything',
  'something',
  'better',
  'improve',
  'clean',
  'up',
  'nice',
  'good',
  'work',
  'make',
  'do',
  'help',
  'me',
  'my',
  'our',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'all',
]);

export function meaningfulWords(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '' && !TASK_FILLER_WORDS.has(word));
}

export const TASK_THINNESS = ['too_short', 'nothing_specific'] as const;

export type TaskThinness = (typeof TASK_THINNESS)[number];

export function taskThinness(task: string): TaskThinness | null {
  const trimmed = task.trim();

  if (trimmed.length < TASK_MIN_CHARS) {
    return 'too_short';
  }

  return meaningfulWords(trimmed).length < TASK_MIN_WORDS ? 'nothing_specific' : null;
}

export function wordsStillNeeded(task: string): number {
  return Math.max(0, TASK_MIN_WORDS - meaningfulWords(task).length);
}
