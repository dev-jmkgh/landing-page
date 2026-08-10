import { escapeHtml } from '../../../utils/text';
import { BRAND } from './brand';
import { renderFooter } from './footer';
import { renderHeader } from './header';

/**
 * The one email layout used by every message JMK sends.
 *
 * Templates supply only their content block; the header, the shell and the footer live
 * here so branding changes in one place. Layout is tables with inline styles because
 * that is what mail clients actually render — no external stylesheet, no flexbox, no
 * JavaScript, nothing that Gmail or Outlook will strip.
 */

export type EmailDocument = {
  subject: string;
  html: string;
  text: string;
};

export type RenderEmailInput = {
  /** Shown in the header strip and used as the document title. */
  title: string;
  /** The grey line clients show next to the subject. Never leave it to chance. */
  preheader: string;
  /** Content block HTML, produced by a template. */
  content: string;
};

export function renderEmail({ title, preheader, content }: RenderEmailInput): string {
  const { colours } = BRAND;
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${colours.page};font-family:Segoe UI,Helvetica,Arial,sans-serif;color:${colours.ink};">
  <div style="display:none;font-size:1px;color:${colours.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    ${escapeHtml(preheader)}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${colours.page};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid ${colours.line};border-radius:6px;overflow:hidden;">
${renderHeader(title)}
          <tr>
            <td style="padding:28px;">
${content}
            </td>
          </tr>
${renderFooter(year)}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * The plain-text counterpart of the layout. Every message ships both parts: a
 * text/plain alternative keeps the mail out of spam filters and readable in clients
 * that refuse HTML.
 */
export function renderText(lines: string[]): string {
  return [
    BRAND.name.toUpperCase(),
    BRAND.tagline,
    '',
    ...lines,
    '',
    '—',
    BRAND.name,
    BRAND.address,
    BRAND.phones.join(' · '),
  ].join('\n');
}
