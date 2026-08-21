export const NEWLINE = String.fromCharCode(10);

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const EMAIL_PALETTE = {
  page: '#08090a',
  card: '#0f1113',
  border: '#1f2225',
  heading: '#f4f5f6',
  body: '#a4abb2',
  faint: '#6d747b',
  markSurface: '#f4f5f6',
  markText: '#08090a',
  accent: '#42d782',
} as const;

export const EMAIL_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const EMAIL_MONO_FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

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

function wordmark(): string {
  return joinLines([
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px">',
    '<tr>',
    `<td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;background:${EMAIL_PALETTE.markSurface};border-radius:11px;font-family:${EMAIL_FONT};font-size:22px;font-weight:700;line-height:40px;color:${EMAIL_PALETTE.markText}">N</td>`,
    `<td style="padding-left:12px;font-family:${EMAIL_FONT};font-size:17px;font-weight:600;color:${EMAIL_PALETTE.heading}">Nimbus</td>`,
    '</tr>',
    '</table>',
  ]);
}

export function layout(heading: string, blocks: readonly string[]): string {
  return joinLines([
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="supported-color-schemes" content="dark">',
    '<title>' + escapeHtml(heading) + '</title>',
    '</head>',
    `<body style="margin:0;padding:0;background:${EMAIL_PALETTE.page}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_PALETTE.page}">`,
    '<tr>',
    '<td align="center" style="padding:32px 16px">',
    `<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;background:${EMAIL_PALETTE.card};border:1px solid ${EMAIL_PALETTE.border};border-radius:14px">`,
    '<tr>',
    `<td style="padding:32px;font-family:${EMAIL_FONT}">`,
    wordmark(),
    `<h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;font-weight:600;color:${EMAIL_PALETTE.heading}">${escapeHtml(heading)}</h1>`,
    ...blocks,
    `<div style="height:1px;background:${EMAIL_PALETTE.border};margin:32px 0 18px"></div>`,
    `<p style="margin:0;font-size:13px;line-height:1.6;color:${EMAIL_PALETTE.faint}">`,
    'Nimbus, a cloud coding agent. It opens pull requests for you to review and never merges them.',
    '</p>',
    '</td>',
    '</tr>',
    '</table>',
    '</td>',
    '</tr>',
    '</table>',
    '</body>',
    '</html>',
  ]);
}

export function paragraph(text: string): string {
  return (
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${EMAIL_PALETTE.body}">` +
    escapeHtml(text) +
    '</p>'
  );
}

export function fineParagraph(text: string): string {
  return (
    `<p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:${EMAIL_PALETTE.faint}">` +
    escapeHtml(text) +
    '</p>'
  );
}
