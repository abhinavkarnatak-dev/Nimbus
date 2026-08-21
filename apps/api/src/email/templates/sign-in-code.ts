import {
  EMAIL_MONO_FONT,
  EMAIL_PALETTE,
  escapeHtml,
  fineParagraph,
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
  return `<p style="margin:26px 0 22px;font-family:${EMAIL_MONO_FONT};font-size:38px;line-height:1.1;letter-spacing:9px;font-weight:600;color:${EMAIL_PALETTE.accent}">${escapeHtml(code)}</p>`;
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
      html: layout('Your sign in code', `Your code expires in ${minutes} minutes.`, [
        paragraph('Enter this code in the window where you started signing in to Nimbus.'),
        codeBlock(data.code),
        fineParagraph(`This code expires in ${minutes} minutes and can only be used once.`),
        fineParagraph(
          'If you did not try to sign in, you can ignore this email. Nobody can sign in with this code unless they also have access to your inbox.',
        ),
      ]),
    };
  },
};
