import {
  RetrievedFileSchema,
  type AgentState,
  type ContextSummary,
  type DescribedImage,
  type RetrievedFile,
} from '@nimbus/contracts';

import { retrieveContext, type RetrievalSource } from '../../retrieval/retriever.js';
import { buildContext, type AttachedText } from '../../routing/context.js';
import { NODE_LIMITS } from './limits.js';

export interface RetrieveInput {
  state: AgentState;
  source: RetrievalSource;
  images?: readonly DescribedImage[];
  attachments?: readonly AttachedText[];
}

export interface RetrieveResult {
  context: string;
  nonce: string;
  retrieved: RetrievedFile[];
  summary: ContextSummary;
  filesSeen: number;
  filesScanned: number;
}

export async function gatherContext(input: RetrieveInput): Promise<RetrieveResult> {
  const asked = [input.state.task, input.state.clarificationAnswer ?? '']
    .filter((part) => part.trim() !== '')
    .join('. ');

  const bundle = await retrieveContext(input.source, {
    task: asked,
    maxFiles: NODE_LIMITS.retrievalFilesMax,
  });

  const retrieved = bundle.files.flatMap((file) =>
    file.windows.map((window) =>
      RetrievedFileSchema.parse({
        path: file.path,
        startLine: window.startLine,
        endLine: window.endLine,
        snippet: window.text,
      }),
    ),
  );

  const built = buildContext({
    task: asked,
    images: input.images ?? [],
    attachments: input.attachments ?? [],
    retrieval: bundle.text,
    maxChars: NODE_LIMITS.contextMaxChars,
  });

  return {
    context: built.text,
    nonce: built.nonce,
    retrieved,
    summary: built.summary,
    filesSeen: bundle.stats.filesSeen,
    filesScanned: bundle.stats.filesScanned,
  };
}
