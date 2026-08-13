export const MAX_NAME_CHARS = 255;
export const FALLBACK_NAME = 'attachment';

const SEPARATORS = /[/\\]/;
const COLLAPSIBLE_SPACE = /\s+/g;
const UNSAFE_FOR_HEADER = /[^\x20-\x7e]|["\\]/g;
const RESERVED = new Set(['', '.', '..']);

const SPOOFING_MARKS = new Set([
  0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

function isDroppable(code: number): boolean {
  if (code <= 0x1f || code === 0x7f) {
    return true;
  }
  if (code >= 0x80 && code <= 0x9f) {
    return true;
  }
  return SPOOFING_MARKS.has(code);
}

function withoutHiddenCharacters(value: string): string {
  let kept = '';

  for (const character of value) {
    if (!isDroppable(character.codePointAt(0) ?? 0)) {
      kept += character;
    }
  }

  return kept;
}

export function baseName(raw: string): string {
  const parts = raw.split(SEPARATORS);
  return parts[parts.length - 1] ?? '';
}

export function safeOriginalName(raw: string): string {
  const cleaned = withoutHiddenCharacters(baseName(raw)).replace(COLLAPSIBLE_SPACE, ' ').trim();

  if (RESERVED.has(cleaned)) {
    return FALLBACK_NAME;
  }

  const capped = (
    cleaned.length > MAX_NAME_CHARS ? cleaned.slice(0, MAX_NAME_CHARS) : cleaned
  ).trim();

  return RESERVED.has(capped) ? FALLBACK_NAME : capped;
}

export function contentDisposition(name: string): string {
  const ascii = name.replace(UNSAFE_FOR_HEADER, '_');
  const fallback = RESERVED.has(ascii) ? FALLBACK_NAME : ascii;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
