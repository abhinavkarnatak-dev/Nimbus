import type { RepositorySummary } from '@nimbus/contracts';

export const MENTION_SHOWN = 6;

export interface ActiveMention {
  start: number;
  query: string;
}

export function fullName(repository: RepositorySummary): string {
  return `${repository.owner}/${repository.name}`;
}

export function mentionToken(repository: RepositorySummary): string {
  return `@${fullName(repository)}`;
}

export function activeMention(text: string, caret: number): ActiveMention | null {
  for (let at = caret - 1; at >= 0; at -= 1) {
    const character = text[at];

    if (character === undefined || /\s/.test(character)) {
      return null;
    }

    if (character === '@') {
      const before = at === 0 ? ' ' : (text[at - 1] ?? ' ');

      return /\s/.test(before) ? { start: at, query: text.slice(at + 1, caret) } : null;
    }
  }

  return null;
}

export function matchRepositories(
  repositories: readonly RepositorySummary[],
  query: string,
): readonly RepositorySummary[] {
  const wanted = query.trim().toLowerCase();

  const found =
    wanted === ''
      ? repositories
      : repositories.filter((one) => fullName(one).toLowerCase().includes(wanted));

  return found.slice(0, MENTION_SHOWN);
}

export function mentionedRepository(
  text: string,
  repositories: readonly RepositorySummary[],
): RepositorySummary | null {
  return repositories.find((one) => text.includes(mentionToken(one))) ?? null;
}

export interface Inserted {
  text: string;
  caret: number;
}

export function insertMention(
  text: string,
  mention: ActiveMention,
  repository: RepositorySummary,
): Inserted {
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.start + 1 + mention.query.length);
  const token = `${mentionToken(repository)} `;

  return { text: `${before}${token}${after}`, caret: before.length + token.length };
}

export function withoutMentions(text: string, repositories: readonly RepositorySummary[]): string {
  return repositories
    .reduce((carried, one) => carried.split(mentionToken(one)).join(''), text)
    .replace(/\s+/g, ' ')
    .trim();
}
