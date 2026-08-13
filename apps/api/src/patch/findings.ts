import type { ApprovalCategory, PolicyDecision, ValidationFindingCode } from '@nimbus/contracts';

export const FINDING_DECISIONS: Readonly<Record<ValidationFindingCode, PolicyDecision>> = {
  BASE_COMMIT_MISMATCH: 'denied',
  PATCH_UNREADABLE: 'denied',
  PATCH_TOO_LARGE: 'denied',
  PATH_ABSOLUTE: 'denied',
  PATH_TRAVERSAL: 'denied',
  PATH_GIT_DIRECTORY: 'denied',
  NESTED_REPOSITORY: 'denied',
  SYMLINK_CHANGE: 'denied',
  SUBMODULE_CHANGE: 'denied',
  BINARY_FILE: 'denied',
  SECRET_DETECTED: 'denied',
  MODE_CHANGE: 'approval_required',
  HIGH_ENTROPY_STRING: 'approval_required',
  PROTECTED_PATH: 'approval_required',
  FILE_DELETED: 'approval_required',
  FILE_RENAMED: 'approval_required',
  TOO_MANY_FILES: 'approval_required',
  TOO_MANY_LINES: 'approval_required',
};

export const APPROVAL_CATEGORY_BY_FINDING: Readonly<
  Partial<Record<ValidationFindingCode, ApprovalCategory>>
> = {
  PROTECTED_PATH: 'protected_path_change',
  FILE_DELETED: 'file_deletion',
  FILE_RENAMED: 'file_rename',
  TOO_MANY_FILES: 'oversized_diff',
  TOO_MANY_LINES: 'oversized_diff',
  MODE_CHANGE: 'uncategorized_action',
  HIGH_ENTROPY_STRING: 'uncategorized_action',
};

const SEVERITY: Readonly<Record<PolicyDecision, number>> = {
  allowed: 0,
  approval_required: 1,
  denied: 2,
};

export function worstDecision(decisions: readonly PolicyDecision[]): PolicyDecision {
  let worst: PolicyDecision = 'allowed';

  for (const decision of decisions) {
    if (SEVERITY[decision] > SEVERITY[worst]) {
      worst = decision;
    }
  }

  return worst;
}

export function decisionFor(code: ValidationFindingCode): PolicyDecision {
  return FINDING_DECISIONS[code];
}
