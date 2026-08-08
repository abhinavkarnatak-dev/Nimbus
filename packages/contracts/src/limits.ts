export const LIMITS = {
  emailMaxChars: 320,
  displayNameMaxChars: 120,
  otpDigits: 8,

  taskMinChars: 10,
  taskMaxChars: 2000,
  messageMaxChars: 2000,
  clarificationAnswerMaxChars: 1000,

  pathMaxChars: 400,
  branchNameMaxChars: 255,
  repositoryNameMaxChars: 100,
  ownerNameMaxChars: 39,

  toolOutputChunkMaxChars: 16_384,
  toolOutputTotalMaxBytes: 262_144,
  summaryMaxChars: 500,
  reasonMaxChars: 1000,
  errorMessageMaxChars: 500,

  maxChangedFiles: 30,
  maxDiffLines: 2000,
  maxAttachmentBytes: 5_242_880,
  maxAttachmentsPerSession: 5,
  maxChecksPerSession: 20,
  maxFilesListed: 200,

  sessionHistoryPageSize: 50,
  approvalPathsMax: 50,
} as const;

export type Limits = typeof LIMITS;
