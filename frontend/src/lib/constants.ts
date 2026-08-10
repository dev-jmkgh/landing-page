/** Shared constants for forms and validation. Mirrors the backend contract exactly. */

/** "Interested In" options for the enquiry forms. */
export const INTEREST_OPTIONS = [
  'JMK Academy',
  'JMK Design Studio',
  'JMK Software Solutions',
  'Export Business',
  'Agriculture',
  'Renewable Energy',
  'Other',
] as const;

export type InterestOption = (typeof INTEREST_OPTIONS)[number];

export const FIELD_LIMITS = {
  name: { min: 2, max: 120 },
  email: { max: 190 },
  phone: { min: 7, max: 20 },
  company: { max: 150 },
  message: { min: 10, max: 2000 },
  position: { max: 120 },
} as const;

export const RESUME_UPLOAD = {
  maxSizeBytes: 5 * 1024 * 1024,
  maxSizeLabel: '5 MB',
  acceptedExtensions: ['.pdf', '.doc', '.docx'],
  acceptedMimeTypes: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  accept: '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

export const SUCCESS_MESSAGES = {
  enquiry:
    'Thank you! Your enquiry has been submitted successfully. Our team will get back to you shortly.',
  application:
    'Thank you! Your application has been submitted successfully. Our team will review it and get back to you shortly.',
} as const;

export const ENQUIRY_STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  in_progress: 'In Progress',
  closed: 'Closed',
} as const;
