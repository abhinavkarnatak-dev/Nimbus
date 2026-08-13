export interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'private_key', pattern: /-----BEGIN[^-]*PRIVATE KEY-----/ },
  { name: 'github_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'github_token', pattern: /\bgh[psour]_[A-Za-z0-9_-]{20,}/ },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { name: 'google_api_key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/ },
  { name: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe_key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/ },
  { name: 'groq_key', pattern: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: 'openai_key', pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  {
    name: 'url_credentials',
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{4,}@/,
  },
  {
    name: 'assignment',
    pattern:
      /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|private[_-]?key)\s*[=:]\s*("[^"\n]{12,}"|'[^'\n]{12,}'|[^\s,;&})\]]{12,})/i,
  },
];

export const ENTROPY_MIN_LENGTH = 32;
export const ENTROPY_THRESHOLD = 4.2;

const TOKEN_PATTERN = /[A-Za-z0-9+/_=-]{20,}/g;
const PURE_HEX = /^[0-9a-f]+$/i;
const PURE_DIGITS = /^[0-9]+$/;

export interface SecretHit {
  readonly name: string;
  readonly line: number;
}

export function shannonEntropy(value: string): number {
  if (value === '') {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    entropy -= share * Math.log2(share);
  }

  return entropy;
}

export function looksRandom(token: string): boolean {
  if (token.length < ENTROPY_MIN_LENGTH) {
    return false;
  }
  if (PURE_HEX.test(token) || PURE_DIGITS.test(token)) {
    return false;
  }
  return shannonEntropy(token) >= ENTROPY_THRESHOLD;
}

export function findNamedSecrets(lines: readonly string[]): SecretHit[] {
  const hits: SecretHit[] = [];

  lines.forEach((line, index) => {
    for (const candidate of SECRET_PATTERNS) {
      if (candidate.pattern.test(line)) {
        hits.push({ name: candidate.name, line: index + 1 });
      }
    }
  });

  return hits;
}

export function findRandomLookingText(lines: readonly string[]): number[] {
  const found: number[] = [];

  lines.forEach((line, index) => {
    const tokens = line.match(TOKEN_PATTERN) ?? [];
    if (tokens.some((token) => looksRandom(token))) {
      found.push(index + 1);
    }
  });

  return found;
}
