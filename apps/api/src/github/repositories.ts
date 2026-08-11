import { RepositorySummarySchema, type RepositorySummary } from '@nimbus/contracts';

export const MAX_REPOSITORIES = 500;
export const REPOSITORY_PAGE_SIZE = 100;
export const MAX_REPOSITORY_PAGES = 10;

export interface GitHubRepositoryPayload {
  id?: unknown;
  name?: unknown;
  private?: unknown;
  visibility?: unknown;
  html_url?: unknown;
  default_branch?: unknown;
  updated_at?: unknown;
  pushed_at?: unknown;
  owner?: { login?: unknown } | null;
}

export function isPublicRepository(payload: GitHubRepositoryPayload): boolean {
  if (payload.private === true) {
    return false;
  }
  if (typeof payload.visibility === 'string' && payload.visibility !== 'public') {
    return false;
  }
  return payload.private === false;
}

export function toRepositorySummary(payload: GitHubRepositoryPayload): RepositorySummary | null {
  if (!isPublicRepository(payload)) {
    return null;
  }

  const updatedAt =
    typeof payload.updated_at === 'string'
      ? payload.updated_at
      : typeof payload.pushed_at === 'string'
        ? payload.pushed_at
        : null;

  if (updatedAt === null) {
    return null;
  }

  const candidate = {
    repositoryId: payload.id,
    owner: payload.owner?.login,
    name: payload.name,
    defaultBranch: payload.default_branch,
    visibility: 'public',
    htmlUrl: payload.html_url,
    updatedAt: new Date(updatedAt).toISOString(),
  };

  const parsed = RepositorySummarySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function toRepositorySummaries(
  payloads: readonly GitHubRepositoryPayload[],
): RepositorySummary[] {
  const summaries: RepositorySummary[] = [];
  const seen = new Set<number>();

  for (const payload of payloads) {
    const summary = toRepositorySummary(payload);

    if (summary === null || seen.has(summary.repositoryId)) {
      continue;
    }
    seen.add(summary.repositoryId);
    summaries.push(summary);

    if (summaries.length >= MAX_REPOSITORIES) {
      break;
    }
  }

  return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
