export const RENDER_LIMITS = {
  lineMaxChars: 2_000,
  linesMax: 2_000,
  inlineMaxChars: 500,
} as const;

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

const OSC = new RegExp(`${ESCAPE}\\][\\s\\S]*?(?:${BELL}|${ESCAPE}\\\\)`, 'g');
const CSI = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const SINGLE_ESCAPE = new RegExp(`${ESCAPE}[@-Z\\\\-_]`, 'g');

const UNRENDERABLE_SOURCE = '(?![\\t\\n\\r])[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]';

const UNRENDERABLE_ONE = new RegExp(`^${UNRENDERABLE_SOURCE}$`, 'u');
const UNRENDERABLE_ALL = new RegExp(UNRENDERABLE_SOURCE, 'gu');

export function isRenderable(character: string): boolean {
  return !UNRENDERABLE_ONE.test(character);
}

export function stripEscapes(text: string): string {
  return text
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(SINGLE_ESCAPE, '')
    .replace(UNRENDERABLE_ALL, '');
}

export function bound(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function plainText(text: string, maxChars = RENDER_LIMITS.inlineMaxChars): string {
  return bound(stripEscapes(text).replace(/\s+/g, ' ').trim(), maxChars);
}

export interface BoundedOutput {
  lines: string[];
  truncated: boolean;
}

export function terminalLines(text: string): BoundedOutput {
  const all = stripEscapes(text).split(/\r\n|\r|\n/);
  const kept = all.slice(0, RENDER_LIMITS.linesMax);

  return {
    lines: kept.map((line) => bound(line, RENDER_LIMITS.lineMaxChars)),
    truncated: all.length > kept.length,
  };
}

export const SAFE_LINK_PROTOCOLS: readonly string[] = ['https:'];

export function safeHref(candidate: string): string | null {
  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  return SAFE_LINK_PROTOCOLS.includes(url.protocol) ? url.toString() : null;
}
