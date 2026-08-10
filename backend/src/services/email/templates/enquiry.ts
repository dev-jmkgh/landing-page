import { renderEmail, renderText, type EmailDocument } from '../layout/base';
import {
  detailLines,
  detailTable,
  formatSubmissionTime,
  paragraph,
  referenceBlock,
  signOff,
  type DetailRow,
} from '../layout/components';

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

function enquiryRows(data: EnquiryEmailData): DetailRow[] {
  return [
    { label: 'Reference', value: data.reference },
    { label: 'Name', value: data.name },
    { label: 'Email', value: data.email, link: 'email' },
    { label: 'Phone', value: data.phone },
    { label: 'Company', value: data.company },
    { label: 'Interested in', value: data.interestedIn },
    { label: 'Submitted', value: formatSubmissionTime(data.submittedAt) },
    { label: 'Form', value: data.source },
  ];
}

/** Sent to every address in ADMIN_EMAILS when an enquiry arrives. */
export function enquiryAdminEmail(data: EnquiryEmailData): EmailDocument {
  const rows = enquiryRows(data);

  return {
    subject: `New Website Enquiry — ${data.interestedIn} — ${data.name} (${data.reference})`,
    html: renderEmail({
      title: 'New website enquiry',
      preheader: `${data.name} enquired about ${data.interestedIn}.`,
      content: [
        paragraph('A new enquiry has been submitted through the website.'),
        detailTable(rows),
        detailTable([{ label: 'Message', value: data.message, multiline: true }]),
        paragraph(`Reply directly to this email to respond to ${data.name}.`, {
          muted: true,
          size: 13,
        }),
      ].join('\n'),
    }),
    text: renderText([
      'A new enquiry has been submitted through the website.',
      '',
      ...detailLines(rows),
      '',
      'Message:',
      data.message,
    ]),
  };
}

/** Sent back to the visitor who submitted the enquiry. */
export function enquiryConfirmationEmail(data: EnquiryEmailData): EmailDocument {
  const rows: DetailRow[] = [
    { label: 'Interested in', value: data.interestedIn },
    { label: 'Submitted', value: formatSubmissionTime(data.submittedAt) },
    { label: 'Your message', value: data.message, multiline: true },
  ];

  return {
    subject: `We have received your enquiry (${data.reference}) — JMK Global Holdings`,
    html: renderEmail({
      title: 'We have received your enquiry',
      preheader: `Your reference number is ${data.reference}.`,
      content: [
        paragraph(`Dear ${data.name},`),
        paragraph(
          'Thank you for contacting JMK Global Holdings. We have received your enquiry and our team will get back to you.',
        ),
        referenceBlock('Your reference number:', data.reference),
        detailTable(rows),
        signOff(),
      ].join('\n'),
    }),
    text: renderText([
      `Dear ${data.name},`,
      '',
      'Thank you for contacting JMK Global Holdings. We have received your enquiry and our team will get back to you.',
      '',
      `Reference: ${data.reference}`,
      ...detailLines(rows.slice(0, 2)),
      '',
      'Your message:',
      data.message,
      '',
      'Warm regards,',
      'JMK Global Holdings',
    ]),
  };
}
