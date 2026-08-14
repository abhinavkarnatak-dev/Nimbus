import type { RetrievalFlag } from '@nimbus/contracts';

import { isProtectedPath } from '../agent/tools/policy-paths.js';
import { isProbablyText } from '../agent/tools/text.js';
import type { WorkspaceEntry } from '../sandbox/index.js';
import { flagLine } from './labeling.js';
import { RETRIEVAL_LIMITS } from './limits.js';
import { isRetrievablePath } from './policy.js';
import type { ParsedQuery } from './query.js';

export interface ScannedFile {
  path: string;
  bytes: number;
  lineCount: number;
  hits: Map<string, number>;
  matchedLines: number[];
  phraseHits: number;
  protectedPath: boolean;
}

export interface ScanStats {
  filesSeen: number;
  filesScanned: number;
  skippedByPolicy: number;
  skippedNotText: number;
  skippedTooLarge: number;
  skippedUnreadable: number;
  bytesScanned: number;
  truncated: boolean;
}

export interface ScanResult {
  files: ScannedFile[];
  documentFrequency: Map<string, number>;
  flags: RetrievalFlag[];
  stats: ScanStats;
}

export type ReadFile = (path: string) => Promise<string>;

export async function scanWorkspace(
  entries: readonly WorkspaceEntry[],
  readFile: ReadFile,
  query: ParsedQuery,
): Promise<ScanResult> {
  const nested = entries
    .filter((entry) => entry.kind === 'repository')
    .map((entry) => `${entry.path}/`);

  const candidates = entries
    .filter((entry) => entry.kind === 'file')
    .sort((left, right) => left.path.localeCompare(right.path));

  const files: ScannedFile[] = [];
  const documentFrequency = new Map<string, number>();
  const flags: RetrievalFlag[] = [];
  const stats: ScanStats = {
    filesSeen: candidates.length,
    filesScanned: 0,
    skippedByPolicy: 0,
    skippedNotText: 0,
    skippedTooLarge: 0,
    skippedUnreadable: 0,
    bytesScanned: 0,
    truncated: false,
  };

  for (const entry of candidates) {
    if (
      stats.filesScanned >= RETRIEVAL_LIMITS.scanMaxFiles ||
      stats.bytesScanned >= RETRIEVAL_LIMITS.scanMaxTotalBytes
    ) {
      stats.truncated = true;
      break;
    }

    if (!isRetrievablePath(entry.path) || nested.some((prefix) => entry.path.startsWith(prefix))) {
      stats.skippedByPolicy += 1;
      continue;
    }

    if (entry.size > RETRIEVAL_LIMITS.scanMaxFileBytes) {
      stats.skippedTooLarge += 1;
      continue;
    }

    let contents: string;
    try {
      contents = await readFile(entry.path);
    } catch {
      stats.skippedUnreadable += 1;
      continue;
    }

    if (!isProbablyText(contents)) {
      stats.skippedNotText += 1;
      continue;
    }

    stats.filesScanned += 1;
    stats.bytesScanned += entry.size;
    files.push(readOneFile(entry.path, contents, query, documentFrequency, flags));
  }

  return { files, documentFrequency, flags, stats };
}

function readOneFile(
  path: string,
  contents: string,
  query: ParsedQuery,
  documentFrequency: Map<string, number>,
  flags: RetrievalFlag[],
): ScannedFile {
  const lines = contents.split('\n');
  const scannable = Math.min(lines.length, RETRIEVAL_LIMITS.scanMaxLinesPerFile);

  const hits = new Map<string, number>();
  const matched = new Set<number>();
  let phraseHits = 0;

  for (let index = 0; index < scannable; index += 1) {
    const lowered = (lines[index] ?? '').toLowerCase();

    if (flags.length < RETRIEVAL_LIMITS.flagsMax) {
      for (const code of flagLine(lowered)) {
        if (flags.length >= RETRIEVAL_LIMITS.flagsMax) {
          break;
        }
        flags.push({ code, path, line: index + 1 });
      }
    }

    if (query.phrase !== null && lowered.includes(query.phrase)) {
      phraseHits += 1;
    }

    for (const term of query.terms) {
      if (!lowered.includes(term)) {
        continue;
      }

      hits.set(term, (hits.get(term) ?? 0) + 1);

      if (matched.size < RETRIEVAL_LIMITS.scanMaxHitsPerFile) {
        matched.add(index + 1);
      }
    }
  }

  for (const term of hits.keys()) {
    documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  return {
    path,
    bytes: Buffer.byteLength(contents, 'utf8'),
    lineCount: lines.length,
    hits,
    matchedLines: [...matched].sort((left, right) => left - right),
    phraseHits,
    protectedPath: isProtectedPath(path),
  };
}
