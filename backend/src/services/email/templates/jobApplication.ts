import { renderEmail, renderText, type EmailDocument } from '../layout/base';
import {
  callout,
  detailLines,
  detailTable,
  formatSubmissionTime,
  paragraph,
  referenceBlock,
  signOff,
  type DetailRow,
} from '../layout/components';

export type JobApplicationEmailData = {
  reference: string;
  fullName: string;
  email: string;
  phone: string;
  position: string;
  message: string | null;
  linkedinUrl: string | null;
  portfolioUrl: string | null;
  experience: string | null;
  location: string | null;
  resumeOriginalName: string | null;
  /** True when the resume travels with this message as an attachment. */
  resumeAttached: boolean;
  submittedAt: Date;
};

/** Sent to every address in ADMIN_EMAILS when an application arrives. */
export function jobApplicationAdminEmail(data: JobApplicationEmailData): EmailDocument {
  const rows: DetailRow[] = [
    { label: 'Reference', value: data.reference },
    { label: 'Applicant', value: data.fullName },
    { label: 'Email', value: data.email, link: 'email' },
    { label: 'Phone', value: data.phone },
    { label: 'Position', value: data.position },
    { label: 'Experience', value: data.experience },
    { label: 'Location', value: data.location },
    { label: 'LinkedIn', value: data.linkedinUrl, link: 'url' },
    { label: 'Portfolio', value: data.portfolioUrl, link: 'url' },
    { label: 'Submitted', value: formatSubmissionTime(data.submittedAt) },
  ];

  const resumeNote = data.resumeAttached
    ? `The resume (${data.resumeOriginalName}) is attached to this email and is also stored securely on the server.`
    : data.resumeOriginalName
      ? `The resume (${data.resumeOriginalName}) is stored securely on the server and can be downloaded from the admin area. It was not attached to this email.`
      : 'No resume was uploaded with this application.';

  return {
    subject: `New Job Application — ${data.position} — ${data.fullName} (${data.reference})`,
    html: renderEmail({
      title: 'New job application',
      preheader: `${data.fullName} applied for ${data.position}.`,
      content: [
        paragraph('A new application has been submitted through the careers page.'),
        detailTable(rows),
        detailTable([{ label: 'Cover letter', value: data.message, multiline: true }]),
        paragraph(resumeNote, { muted: true, size: 13 }),
        paragraph(`Reply directly to this email to contact ${data.fullName}.`, {
          muted: true,
          size: 13,
        }),
      ].join('\n'),
    }),
    text: renderText([
      'A new application has been submitted through the careers page.',
      '',
      ...detailLines(rows),
      ...(data.message ? ['', 'Cover letter:', data.message] : []),
      '',
      resumeNote,
    ]),
  };
}

/**
 * Sent back to the applicant.
 *
 * Deliberately makes no promise about an interview, a decision, a response time or
 * employment — only that the application arrived and will be reviewed.
 */
export function jobApplicationConfirmationEmail(data: JobApplicationEmailData): EmailDocument {
  return {
    subject: 'Application Received — JMK Global Holdings',
    html: renderEmail({
      title: 'Application received',
      preheader: `We have received your application for ${data.position}.`,
      content: [
        paragraph(`Dear ${data.fullName},`),
        paragraph(
          'Thank you for your interest in joining JMK Global Holdings. We have received your application and our team will review it.',
        ),
        callout('Application received', `Position applied for: ${data.position}`),
        '<div style="height:20px;"></div>',
        referenceBlock('Your reference number:', data.reference),
        signOff(),
      ].join('\n'),
    }),
    text: renderText([
      `Dear ${data.fullName},`,
      '',
      'Thank you for your interest in joining JMK Global Holdings. We have received your application and our team will review it.',
      '',
      `Position applied for: ${data.position}`,
      `Reference: ${data.reference}`,
      '',
      'Warm regards,',
      'JMK Global Holdings',
    ]),
  };
}
