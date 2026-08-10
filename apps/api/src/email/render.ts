export const NEWLINE = String.fromCharCode(10);

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EmailTemplate<TData> {
  name: string;
  render(data: TData): RenderedEmail;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

export function joinLines(lines: readonly string[]): string {
  return lines.join(NEWLINE);
}

export function safeLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  return escapeHtml(parsed.toString());
}

export function layout(heading: string, blocks: readonly string[]): string {
  return joinLines([
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>' + escapeHtml(heading) + '</title></head>',
    '<body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,sans-serif;color:#1b1f24">',
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">',
    '<h1 style="margin:0 0 16px;font-size:20px">' + escapeHtml(heading) + '</h1>',
    ...blocks,
    '<p style="margin:24px 0 0;font-size:12px;color:#6b7280">Nimbus, a cloud coding agent.</p>',
    '</div>',
    '</body>',
    '</html>',
  ]);
}

export function paragraph(text: string): string {
  return '<p style="margin:0 0 12px;font-size:15px;line-height:1.5">' + escapeHtml(text) + '</p>';
}
