import { redactSecrets } from '../../logging/redact.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?<>=!]*[ -/]*[@-~]`, 'g');
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const DCS_SEQUENCE = new RegExp(`${ESC}[P^_][^${ESC}]*(?:${ESC}\\\\)?`, 'g');
const CHARSET_SEQUENCE = new RegExp(`${ESC}[()*+][@-~]`, 'g');
const SINGLE_ESCAPE = new RegExp(`${ESC}[@-Z\\\\-_0-9<=>]`, 'g');
const LEFTOVER_ESCAPE = new RegExp(ESC, 'g');

const range = (from: number, to: number): string =>
  `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;

const CONTROL_CHARACTERS = new RegExp(`[${range(0, 8)}${range(11, 31)}${range(127, 159)}]`, 'g');

export const TRUNCATION_NOTICE = '... output trimmed in the middle ...';

export function stripTerminalSequences(value: string): string {
  return value
    .replace(OSC_SEQUENCE, '')
    .replace(DCS_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(CHARSET_SEQUENCE, '')
    .replace(SINGLE_ESCAPE, '')
    .replace(LEFTOVER_ESCAPE, '')
    .replace(/\r\n/g, '\n')
    .replace(CONTROL_CHARACTERS, '');
}

export function keepEndsOf(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean; droppedChars: number } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false, droppedChars: 0 };
  }

  const notice = `\n${TRUNCATION_NOTICE}\n`;

  if (maxChars <= notice.length) {
    return { text: '', truncated: true, droppedChars: value.length };
  }

  const room = maxChars - notice.length;
  const head = Math.ceil(room * 0.4);
  const tail = room - head;

  const text = `${value.slice(0, head)}${notice}${tail === 0 ? '' : value.slice(value.length - tail)}`;
  return { text, truncated: true, droppedChars: value.length - room };
}

export interface CleanedOutput {
  text: string;
  truncated: boolean;
  redacted: boolean;
  droppedChars: number;
}

export function cleanCommandOutput(raw: string, maxChars: number): CleanedOutput {
  const stripped = stripTerminalSequences(raw);
  const safe = redactSecrets(stripped);
  const clipped = keepEndsOf(safe, maxChars);

  return {
    text: clipped.text,
    truncated: clipped.truncated,
    redacted: safe !== stripped,
    droppedChars: clipped.droppedChars,
  };
}
