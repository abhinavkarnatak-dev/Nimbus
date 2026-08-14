import { fileName, pathSegments } from '../agent/tools/policy-paths.js';
import { nameWords } from './policy.js';
import type { ParsedQuery } from './query.js';
import type { ScannedFile } from './scan.js';

export const SATURATION = 2;
export const NAME_WORD_WEIGHT = 3;
export const NAME_SUBSTRING_WEIGHT = 1.5;
export const DIRECTORY_WORD_WEIGHT = 1;
export const PHRASE_BONUS = 3;
export const TEST_PENALTY = 0.6;
export const LARGE_FILE_BYTES = 32_768;
export const LARGE_FILE_PENALTY = 0.8;

export interface RankedFile {
  path: string;
  score: number;
  matchedTerms: string[];
  hits: number;
  matchedLines: number[];
  lineCount: number;
  bytes: number;
  protectedPath: boolean;
}

const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /\.(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)(__tests__|__mocks__|tests?|spec|specs)\//i,
];

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function inverseDocumentFrequency(scanned: number, matching: number): number {
  if (scanned <= 0) {
    return 0;
  }
  return Math.log((scanned - matching + 0.5) / (matching + 0.5) + 1);
}

export function saturate(hits: number): number {
  if (hits <= 0) {
    return 0;
  }
  return hits / (hits + SATURATION);
}

function stemOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

function nameWeight(path: string, term: string): number {
  const stem = stemOf(path);
  const loweredStem = stem.toLowerCase();

  if (nameWords(stem).includes(term)) {
    return NAME_WORD_WEIGHT;
  }

  if (loweredStem.includes(term)) {
    return NAME_SUBSTRING_WEIGHT;
  }

  const directories = pathSegments(path).slice(0, -1);

  if (directories.some((segment) => nameWords(segment).includes(term))) {
    return DIRECTORY_WORD_WEIGHT;
  }
  return 0;
}

export function scoreFile(
  file: ScannedFile,
  query: ParsedQuery,
  documentFrequency: ReadonlyMap<string, number>,
  scanned: number,
): number {
  let total = 0;

  for (const term of query.terms) {
    const weight = inverseDocumentFrequency(scanned, documentFrequency.get(term) ?? 0);

    if (weight <= 0) {
      continue;
    }

    total += weight * saturate(file.hits.get(term) ?? 0);
    total += weight * nameWeight(file.path, term);
  }

  if (file.phraseHits > 0) {
    total += PHRASE_BONUS;
  }

  if (isTestPath(file.path) && !query.wantsTests) {
    total *= TEST_PENALTY;
  }

  if (file.bytes > LARGE_FILE_BYTES) {
    total *= LARGE_FILE_PENALTY;
  }
  return total;
}

export function rankFiles(
  files: readonly ScannedFile[],
  query: ParsedQuery,
  documentFrequency: ReadonlyMap<string, number>,
  scanned: number,
): RankedFile[] {
  const ranked: RankedFile[] = [];

  for (const file of files) {
    const score = scoreFile(file, query, documentFrequency, scanned);

    if (score <= 0) {
      continue;
    }

    let hits = 0;
    for (const count of file.hits.values()) {
      hits += count;
    }

    ranked.push({
      path: file.path,
      score,
      matchedTerms: query.terms.filter((term) => file.hits.has(term)),
      hits,
      matchedLines: file.matchedLines,
      lineCount: file.lineCount,
      bytes: file.bytes,
      protectedPath: file.protectedPath,
    });
  }

  return ranked.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
}
