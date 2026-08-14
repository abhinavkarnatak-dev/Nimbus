import { LIMITS, MAX_DESCRIBED_IMAGES } from '@nimbus/contracts';

export const ROUTING_LIMITS = {
  contextMaxChars: 120_000,
  taskMaxChars: LIMITS.taskMaxChars,
  attachmentTextMaxChars: 20_000,
  attachmentsMax: LIMITS.maxAttachmentsPerSession,
  imagesMax: MAX_DESCRIBED_IMAGES,
  descriptionMaxChars: 2_000,
} as const;

export type RoutingLimits = typeof ROUTING_LIMITS;
