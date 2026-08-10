import {
  escapeHtml,
  joinLines,
  layout,
  paragraph,
  type EmailTemplate,
  type RenderedEmail,
} from '../render.js';

export interface SignInCodeData {
  code: string;
  expiresInMinutes: number;
}

function codeBlock(code: string): string {
  return joinLines([
    '<p style="margin:0 0 20px;font-size:32px;letter-spacing:6px;font-weight:600;font-family:ui-monospace,monospace">',
    escapeHtml(code),
    '</p>',
  ]);
}

export const signInCodeTemplate: EmailTemplate<SignInCodeData> = {
  name: 'sign-in-code',

  render(data: SignInCodeData): RenderedEmail {
    const minutes = String(data.expiresInMinutes);

    return {
      subject: 'Your Nimbus sign in code',
      text: joinLines([
        'Your Nimbus sign in code is:',
        '',
        data.code,
        '',
        `This code expires in ${minutes} minutes and can only be used once.`,
        '',
        'If you did not try to sign in, you can ignore this email. Nobody can sign in with this',
        'code unless they also have access to your inbox.',
        '',
        'Nimbus, a cloud coding agent.',
      ]),
      html: layout('Your sign in code', [
        paragraph('Use this code to finish signing in to Nimbus.'),
        codeBlock(data.code),
        paragraph(`This code expires in ${minutes} minutes and can only be used once.`),
        paragraph(
          'If you did not try to sign in, you can ignore this email. Nobody can sign in with this code unless they also have access to your inbox.',
        ),
      ]),
    };
  },
};
