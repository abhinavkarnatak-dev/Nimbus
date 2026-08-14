export const CLONE_ERROR_CODES = [
  'CLONE_TREE_TRUNCATED',
  'CLONE_COMMIT_NOT_FOUND',
  'CLONE_FAILED',
] as const;

export type CloneErrorCode = (typeof CLONE_ERROR_CODES)[number];

export class CloneError extends Error {
  readonly code: CloneErrorCode;

  readonly detail: string | undefined;

  constructor(
    code: CloneErrorCode,
    message: string,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CloneError';
    this.code = code;
    this.detail = options.detail;
  }
}
