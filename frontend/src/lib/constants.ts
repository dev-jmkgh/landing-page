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

/** Experience bands offered by the application form. Mirrors the backend enum. */
export const EXPERIENCE_LEVELS = [
  'Fresher',
  'Less than 1 year',
  '1–3 years',
  '3–5 years',
  '5–10 years',
  'More than 10 years',
] as const;

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

/**
 * Applications move through a hiring review, not an enquiry follow-up, so they have
 * their own vocabulary. Mirrors APPLICATION_STATUSES in the backend schema.
 */
export const APPLICATION_STATUS_LABELS = {
  new: 'New',
  reviewing: 'Reviewing',
  shortlisted: 'Shortlisted',
  rejected: 'Rejected',
  hired: 'Hired',
} as const;

/** Ordered vocabularies, derived so the lists and the labels cannot drift apart. */
export const ENQUIRY_STATUSES = Object.keys(
  ENQUIRY_STATUS_LABELS,
) as (keyof typeof ENQUIRY_STATUS_LABELS)[];

export const APPLICATION_STATUSES = Object.keys(
  APPLICATION_STATUS_LABELS,
) as (keyof typeof APPLICATION_STATUS_LABELS)[];
