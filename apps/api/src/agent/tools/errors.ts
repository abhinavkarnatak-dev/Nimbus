export const TOOL_ERROR_CODES = [
  'PATH_INVALID',
  'PATH_OUTSIDE_WORKSPACE',
  'PATH_LINK_LOOP',
  'PATH_NESTED_REPOSITORY',
  'PATH_IGNORED',
  'PATH_NOT_A_FILE',
  'FILE_NOT_FOUND',
  'FILE_EXISTS',
  'FILE_TOO_LARGE',
  'FILE_NOT_TEXT',
  'SEARCH_INVALID',
  'PATCH_MALFORMED',
  'PATCH_CONTEXT_MISMATCH',
  'PATCH_TOO_LARGE',
  'PATCH_APPROVAL_REQUIRED',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly path: string | null;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: { path?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolError';
    this.code = code;
    this.path = options.path ?? null;
  }
}
