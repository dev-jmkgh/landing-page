import { config } from '../config/env';
import { escapeHtml, escapeHtmlMultiline } from '../utils/text';

/**
 * Email bodies.
 *
 * Every interpolated value is user-supplied, so it is HTML-escaped without exception.
 * Layout uses tables and inline styles because that is what mail clients render
 * reliably.
 */

const BRAND = {
  navy: '#0a1b2e',
  navySoft: '#0f2742',
  accent: '#c08b2e',
  ink: '#101828',
  muted: '#5b6572',
  line: '#e4e7ec',
};

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f5f8;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:${BRAND.ink};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2f5f8;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid ${BRAND.line};border-radius:6px;overflow:hidden;">
          <tr>
            <td style="background-color:${BRAND.navy};padding:24px 28px;border-bottom:3px solid ${BRAND.accent};">
              <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.2px;">JMK Global Holdings</div>
              <div style="color:#b6c4d4;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-top:4px;">${escapeHtml(title)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background-color:#f7f9fb;padding:18px 28px;border-top:1px solid ${BRAND.line};color:${BRAND.muted};font-size:12px;line-height:1.6;">
              JMK Global Holdings · 22, NSR Road, Saibaba Kovil, Coimbatore, Tamil Nadu 641011, India<br />
              <a href="${config.appUrl}" style="color:${BRAND.navySoft};">${escapeHtml(config.appUrl.replace(/^https?:\/\//, ''))}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function detailRows(rows: { label: string; value: string; multiline?: boolean }[]): string {
  return rows
    .filter((row) => row.value.trim().length > 0)
    .map(
      (row) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid ${BRAND.line};color:${BRAND.muted};font-size:13px;width:150px;vertical-align:top;">${escapeHtml(row.label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid ${BRAND.line};font-size:14px;vertical-align:top;">${
            row.multiline ? escapeHtmlMultiline(row.value) : escapeHtml(row.value)
          }</td>
        </tr>`,
    )
    .join('');
}

function plainRows(rows: { label: string; value: string }[]): string {
  return rows
    .filter((row) => row.value.trim().length > 0)
    .map((row) => `${row.label}: ${row.value}`)
    .join('\n');
}

const formatter = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'full',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export function formatSubmissionTime(date: Date): string {
  return `${formatter.format(date)} IST`;
}

/* -------------------------------------------------------------------------- */
/* Enquiries                                                                   */
/* -------------------------------------------------------------------------- */

export type EnquiryEmailData = {
  reference: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  interestedIn: string;
  message: string;
  source: string;
  submittedAt: Date;
};

export function enquiryNotification(data: EnquiryEmailData) {
  const rows = [
    { label: 'Reference', value: data.reference },
    { label: 'Name', value: data.name },
    { label: 'Email', value: data.email },
    { label: 'Phone', value: data.phone },
    { label: 'Company', value: data.company ?? '' },
    { label: 'Interested in', value: data.interestedIn },
    { label: 'Submitted', value: formatSubmissionTime(data.submittedAt) },
    { label: 'Form', value: data.source },
  ];

  const html = layout(
    'New website enquiry',
    `
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;">
      A new enquiry has been submitted through the website.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${detailRows(rows)}
      ${detailRows([{ label: 'Message', value: data.message, multiline: true }])}
    </table>
    <p style="margin:22px 0 0;font-size:13px;color:${BRAND.muted};">
      Reply directly to this email to respond to ${escapeHtml(data.name)}.
    </p>`,
  );

  const text = [
    'A new enquiry has been submitted through the website.',
    '',
    plainRows(rows),
    '',
    'Message:',
    data.message,
  ].join('\n');

  return {
    subject: `New enquiry — ${data.interestedIn} — ${data.name} (${data.reference})`,
    html,
    text,
  };
}

export function enquiryAutoReply(data: EnquiryEmailData) {
  const html = layout(
    'We have received your enquiry',
    `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Dear ${escapeHtml(data.name)},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
      Thank you for contacting JMK Global Holdings. We have received your enquiry and our
      team will get back to you.
    </p>
    <p style="margin:0 0 8px;font-size:14px;color:${BRAND.muted};">Your reference number:</p>
    <p style="margin:0 0 20px;font-size:18px;font-weight:700;letter-spacing:1px;">${escapeHtml(data.reference)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${detailRows([
        { label: 'Interested in', value: data.interestedIn },
        { label: 'Submitted', value: formatSubmissionTime(data.submittedAt) },
        { label: 'Your message', value: data.message, multiline: true },
      ])}
    </table>
    <p style="margin:22px 0 0;font-size:14px;line-height:1.6;">
      If your enquiry is urgent, call us on +91 88707 73366 or +91 73057 55370.
    </p>
    <p style="margin:16px 0 0;font-size:14px;line-height:1.6;">
      Warm regards,<br />JMK Global Holdings
    </p>`,
  );

  const text = [
    `Dear ${data.name},`,
    '',
    'Thank you for contacting JMK Global Holdings. We have received your enquiry and our team will get back to you.',
    '',
    `Reference: ${data.reference}`,
    `Interested in: ${data.interestedIn}`,
    `Submitted: ${formatSubmissionTime(data.submittedAt)}`,
    '',
    'Your message:',
    data.message,
    '',
    'If your enquiry is urgent, call us on +91 88707 73366 or +91 73057 55370.',
    '',
    'Warm regards,',
    'JMK Global Holdings',
  ].join('\n');

  return {
    subject: `We have received your enquiry (${data.reference}) — JMK Global Holdings`,
    html,
    text,
  };
}

/* -------------------------------------------------------------------------- */
/* Career applications                                                         */
/* -------------------------------------------------------------------------- */

export type ApplicationEmailData = {
  reference: string;
  fullName: string;
  email: string;
  phone: string;
  position: string;
  message: string | null;
  resumeOriginalName: string | null;
  submittedAt: Date;
};

export function applicationNotification(data: ApplicationEmailData) {
  const rows = [
    { label: 'Reference', value: data.reference },
    { label: 'Applicant', value: data.fullName },
    { label: 'Email', value: data.email },
    { label: 'Phone', value: data.phone },
    { label: 'Position', value: data.position },
    { label: 'Resume', value: data.resumeOriginalName ?? 'Not attached' },
    { label: 'Submitted', value: formatSubmissionTime(data.submittedAt) },
  ];

  const html = layout(
    'New career application',
    `
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;">
      A new application has been submitted through the careers page.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${detailRows(rows)}
      ${data.message ? detailRows([{ label: 'Message', value: data.message, multiline: true }]) : ''}
    </table>
    <p style="margin:22px 0 0;font-size:13px;color:${BRAND.muted};">
      The resume is stored securely and can be downloaded from the admin area.
    </p>`,
  );

  const text = [
    'A new application has been submitted through the careers page.',
    '',
    plainRows(rows),
    ...(data.message ? ['', 'Message:', data.message] : []),
    '',
    'The resume is stored securely and can be downloaded from the admin area.',
  ].join('\n');

  return {
    subject: `New application — ${data.position} — ${data.fullName} (${data.reference})`,
    html,
    text,
  };
}

export function applicationAutoReply(data: ApplicationEmailData) {
  const html = layout(
    'We have received your application',
    `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Dear ${escapeHtml(data.fullName)},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
      Thank you for your interest in JMK Global Holdings. We have received your application
      for the <strong>${escapeHtml(data.position)}</strong> role. Our team reviews every
      application and will contact you if there is a suitable match.
    </p>
    <p style="margin:0 0 8px;font-size:14px;color:${BRAND.muted};">Your reference number:</p>
    <p style="margin:0 0 20px;font-size:18px;font-weight:700;letter-spacing:1px;">${escapeHtml(data.reference)}</p>
    <p style="margin:16px 0 0;font-size:14px;line-height:1.6;">
      Warm regards,<br />JMK Global Holdings
    </p>`,
  );

  const text = [
    `Dear ${data.fullName},`,
    '',
    `Thank you for your interest in JMK Global Holdings. We have received your application for the ${data.position} role. Our team reviews every application and will contact you if there is a suitable match.`,
    '',
    `Reference: ${data.reference}`,
    '',
    'Warm regards,',
    'JMK Global Holdings',
  ].join('\n');

  return {
    subject: `We have received your application (${data.reference}) — JMK Global Holdings`,
    html,
    text,
  };
}
