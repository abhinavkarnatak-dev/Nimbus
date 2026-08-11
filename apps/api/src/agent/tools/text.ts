const NUL = String.fromCharCode(0);
const SAMPLE_CHARS = 8_192;
const CONTROL_RATIO_LIMIT = 0.15;

export function isProbablyText(contents: string): boolean {
  if (contents === '') {
    return true;
  }

  if (contents.includes(NUL)) {
    return false;
  }

  const sample = contents.slice(0, SAMPLE_CHARS);
  let control = 0;

  for (const character of sample) {
    const code = character.codePointAt(0) ?? 0;
    const printable = code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);

    if (!printable) {
      control += 1;
    }
  }
  return control / sample.length <= CONTROL_RATIO_LIMIT;
}

export function clipLine(line: string, maxChars: number): { text: string; truncated: boolean } {
  const stripped = line.replace(/\r$/, '');

  if (stripped.length <= maxChars) {
    return { text: stripped, truncated: false };
  }
  return { text: stripped.slice(0, maxChars), truncated: true };
}
