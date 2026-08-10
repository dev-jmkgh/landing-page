import { escapeHtml, escapeHtmlMultiline } from '../../../utils/text';
import { BRAND } from './brand';

/**
 * Content building blocks shared by the templates.
 *
 * Every function here escapes what it is given. No template is allowed to interpolate
 * a user-supplied value into HTML by itself — that rule is what keeps a cover letter
 * containing `<script>` or `<img onerror=…>` from becoming markup in an inbox.
 */

const { colours } = BRAND;

export type DetailRow = {
  label: string;
  value: string | null | undefined;
  /** Preserve line breaks — for messages and cover letters. */
  multiline?: boolean;
  /** Render as a mailto:/https: link. Only ever used for values we have validated. */
  link?: 'email' | 'url';
};

function usable(row: DetailRow): row is DetailRow & { value: string } {
  return typeof row.value === 'string' && row.value.trim().length > 0;
}

function renderValue(row: DetailRow & { value: string }): string {
  if (row.link === 'email') {
    const address = encodeURI(`mailto:${row.value}`);
    return `<a href="${escapeHtml(address)}" style="color:${colours.navySoft};">${escapeHtml(row.value)}</a>`;
  }

  if (row.link === 'url') {
    // Only http(s) becomes a link; anything else is shown as inert text so a
    // `javascript:` value supplied by an applicant cannot become clickable.
    const safe = /^https?:\/\//i.test(row.value);
    return safe
      ? `<a href="${escapeHtml(encodeURI(row.value))}" style="color:${colours.navySoft};">${escapeHtml(row.value)}</a>`
      : escapeHtml(row.value);
  }

  return row.multiline ? escapeHtmlMultiline(row.value) : escapeHtml(row.value);
}

/** A label/value table. Empty values are dropped rather than shown blank. */
export function detailTable(rows: DetailRow[]): string {
  const body = rows
    .filter(usable)
    .map(
      (row) => `
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid ${colours.line};color:${colours.muted};font-size:13px;width:150px;vertical-align:top;">${escapeHtml(row.label)}</td>
                  <td style="padding:10px 0;border-bottom:1px solid ${colours.line};font-size:14px;vertical-align:top;word-break:break-word;">${renderValue(row)}</td>
                </tr>`,
    )
    .join('');

  if (!body) return '';

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}
              </table>`;
}

export function paragraph(text: string, options: { muted?: boolean; size?: number } = {}): string {
  const colour = options.muted ? colours.muted : colours.ink;
  const size = options.size ?? 15;
  return `
              <p style="margin:0 0 16px;font-size:${size}px;line-height:1.6;color:${colour};">${escapeHtml(text)}</p>`;
}

/** A prominent reference number block. */
export function referenceBlock(label: string, reference: string): string {
  return `
              <p style="margin:0 0 6px;font-size:13px;color:${colours.muted};">${escapeHtml(label)}</p>
              <p style="margin:0 0 20px;font-size:18px;font-weight:700;letter-spacing:1px;color:${colours.ink};">${escapeHtml(reference)}</p>`;
}

/** A tinted callout, used for the "we received it" confirmation banner. */
export function callout(heading: string, body: string): string {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${colours.panel};border-left:3px solid ${colours.accent};border-radius:4px;">
                <tr>
                  <td style="padding:16px 18px;">
                    <div style="font-size:15px;font-weight:700;color:${colours.ink};">${escapeHtml(heading)}</div>
                    <div style="margin-top:6px;font-size:14px;line-height:1.6;color:${colours.muted};">${escapeHtml(body)}</div>
                  </td>
                </tr>
              </table>`;
}

export function signOff(): string {
  return `
              <p style="margin:22px 0 0;font-size:14px;line-height:1.6;color:${colours.ink};">
                Warm regards,<br />${escapeHtml(BRAND.name)}
              </p>`;
}

/** Plain-text rendering of the same rows, for the text/plain alternative. */
export function detailLines(rows: DetailRow[]): string[] {
  return rows.filter(usable).map((row) => `${row.label}: ${row.value}`);
}

const formatter = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'full',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export function formatSubmissionTime(date: Date): string {
  return `${formatter.format(date)} IST`;
}
