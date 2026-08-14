import {
  RetrievalSummarySchema,
  type RetrievalFlag,
  type RetrievalStats,
  type RetrievalSummary,
} from '@nimbus/contracts';

import type { WorkspaceEntry } from '../sandbox/index.js';
import { buildExcerpt, type ExcerptWindow } from './excerpt.js';
import { bundleHeader, labelBlock, makeNonce } from './labeling.js';
import { RETRIEVAL_LIMITS } from './limits.js';
import { parseQuery } from './query.js';
import { rankFiles } from './rank.js';
import { scanWorkspace, type ReadFile } from './scan.js';
import { summarizeTree, type TreeSummary } from './tree.js';

export interface RetrievalSource {
  listEntries: () => Promise<WorkspaceEntry[]>;
  readFile: ReadFile;
}

export interface RetrieveInput {
  task: string;
  maxFiles?: number;
}

export interface RetrievedFile {
  path: string;
  score: number;
  matchedTerms: string[];
  hits: number;
  lineCount: number;
  protectedPath: boolean;
  flagged: boolean;
  windows: ExcerptWindow[];
}

export interface RetrievalBundle {
  task: string;
  terms: string[];
  tree: TreeSummary;
  files: RetrievedFile[];
  flags: RetrievalFlag[];
  stats: RetrievalStats;
  nonce: string;
  text: string;
  truncated: boolean;
}

function fileCount(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
    return RETRIEVAL_LIMITS.filesReturnedDefault;
  }
  return Math.min(requested, RETRIEVAL_LIMITS.filesReturnedMax);
}

export async function retrieveContext(
  source: RetrievalSource,
  input: RetrieveInput,
): Promise<RetrievalBundle> {
  const read: ReadFile = async (path) => await source.readFile(path);
  const query = parseQuery(input.task);
  const entries = await source.listEntries();
  const tree = summarizeTree(entries);
  const scan = await scanWorkspace(entries, read, query);
  const ranked = rankFiles(scan.files, query, scan.documentFrequency, scan.stats.filesScanned);
  const flaggedPaths = new Set(scan.flags.map((flag) => flag.path));

  const wanted = ranked.slice(0, fileCount(input.maxFiles));
  const files: RetrievedFile[] = [];

  for (const candidate of wanted) {
    let contents: string;
    try {
      contents = await read(candidate.path);
    } catch {
      continue;
    }

    files.push({
      path: candidate.path,
      score: candidate.score,
      matchedTerms: candidate.matchedTerms,
      hits: candidate.hits,
      lineCount: candidate.lineCount,
      protectedPath: candidate.protectedPath,
      flagged: flaggedPaths.has(candidate.path),
      windows: buildExcerpt(contents, candidate.matchedLines),
    });
  }

  const material = [tree.text, ...files.flatMap((file) => file.windows.map((one) => one.text))];
  const nonce = makeNonce(material);
  const rendered = render(nonce, tree, files, scan.flags.length > 0);

  return {
    task: query.task,
    terms: query.terms,
    tree,
    files,
    flags: scan.flags,
    stats: scan.stats,
    nonce,
    text: rendered.text,
    truncated: rendered.truncated || tree.truncated || scan.stats.truncated,
  };
}

function render(
  nonce: string,
  tree: TreeSummary,
  files: readonly RetrievedFile[],
  flagged: boolean,
): { text: string; truncated: boolean } {
  const blocks: string[] = [bundleHeader(flagged)];
  let used = blocks[0]?.length ?? 0;
  let truncated = false;

  const treeBlock = labelBlock(nonce, { kind: 'tree' }, tree.text);

  if (used + treeBlock.length <= RETRIEVAL_LIMITS.bundleMaxChars) {
    blocks.push(treeBlock);
    used += treeBlock.length;
  } else {
    truncated = true;
  }

  for (const file of files) {
    for (const window of file.windows) {
      const block = labelBlock(
        nonce,
        {
          kind: 'file',
          path: file.path,
          lines: `${String(window.startLine)}-${String(window.endLine)}`,
        },
        window.text,
      );

      if (used + block.length > RETRIEVAL_LIMITS.bundleMaxChars) {
        return { text: blocks.join('\n\n'), truncated: true };
      }

      blocks.push(block);
      used += block.length;
    }
  }
  return { text: blocks.join('\n\n'), truncated };
}

export function summarizeRetrieval(bundle: RetrievalBundle): RetrievalSummary {
  return RetrievalSummarySchema.parse({
    terms: bundle.terms,
    files: bundle.files.map((file) => ({
      path: file.path,
      score: Math.round(file.score * 1000) / 1000,
      matchedTerms: file.matchedTerms,
      hits: file.hits,
      lines: file.lineCount,
      protectedPath: file.protectedPath,
    })),
    flags: bundle.flags,
    stats: bundle.stats,
    characters: bundle.text.length,
  });
}
