export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export interface SchemaIssue {
  path: PropertyKey[];
  message: string;
  code?: string;
}

export function describeIssues(error: { issues: readonly SchemaIssue[] }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || 'the answer'} ${issue.message}`)
    .join('; ');
}

export function issueCodes(error: { issues: readonly SchemaIssue[] }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || 'root'}:${issue.code ?? 'invalid'}`)
    .join(',');
}
