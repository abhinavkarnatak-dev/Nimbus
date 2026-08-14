import { RETRIEVAL_LIMITS } from './limits.js';

export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'after',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'back',
  'be',
  'because',
  'been',
  'before',
  'being',
  'but',
  'by',
  'can',
  'cannot',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'done',
  'each',
  'for',
  'from',
  'get',
  'gets',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'like',
  'make',
  'makes',
  'may',
  'me',
  'more',
  'most',
  'must',
  'my',
  'need',
  'needs',
  'no',
  'not',
  'now',
  'of',
  'on',
  'one',
  'only',
  'or',
  'other',
  'our',
  'out',
  'over',
  'please',
  'put',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'too',
  'under',
  'up',
  'us',
  'use',
  'used',
  'uses',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

export const TEST_WORDS: readonly string[] = ['test', 'tests', 'spec', 'specs', 'testing'];

export interface ParsedQuery {
  task: string;
  terms: string[];
  phrase: string | null;
  wantsTests: boolean;
}

const NOT_WORD = /[^A-Za-z0-9]+/;

function splitIdentifier(word: string): string[] {
  const spaced = word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2');

  return spaced.split(' ').filter((part) => part !== '');
}

export function singular(term: string): string | null {
  if (term.length > 4 && term.endsWith('ies')) {
    return `${term.slice(0, -3)}y`;
  }

  if (term.length > 4 && /(?:ss|sh|ch|x|z)es$/.test(term)) {
    return term.slice(0, -2);
  }

  if (term.length > 3 && term.endsWith('s') && !/(?:ss|us|is|as)$/.test(term)) {
    return term.slice(0, -1);
  }
  return null;
}

function usable(term: string): boolean {
  return (
    term.length >= RETRIEVAL_LIMITS.termMinChars &&
    term.length <= RETRIEVAL_LIMITS.termMaxChars &&
    !STOP_WORDS.has(term)
  );
}

export function parseQuery(task: string): ParsedQuery {
  const trimmed = task.slice(0, RETRIEVAL_LIMITS.taskMaxChars).trim();
  const words = trimmed.split(NOT_WORD).filter((word) => word !== '');
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const word of words) {
    const parts = [word, ...splitIdentifier(word)];
    const candidates = parts.flatMap((part) => {
      const stem = singular(part.toLowerCase());
      return stem === null ? [part] : [part, stem];
    });

    for (const candidate of candidates) {
      const term = candidate.toLowerCase();

      if (!usable(term) || seen.has(term)) {
        continue;
      }

      seen.add(term);
      terms.push(term);

      if (terms.length >= RETRIEVAL_LIMITS.termsMax) {
        return finish(trimmed, terms);
      }
    }
  }
  return finish(trimmed, terms);
}

function finish(task: string, terms: string[]): ParsedQuery {
  const collapsed = task.replace(/\s+/g, ' ').toLowerCase();
  const phrase =
    collapsed.length >= RETRIEVAL_LIMITS.termMinChars &&
    collapsed.length <= RETRIEVAL_LIMITS.phraseMaxChars
      ? collapsed
      : null;

  return {
    task,
    terms,
    phrase,
    wantsTests: terms.some((term) => TEST_WORDS.includes(term)),
  };
}
