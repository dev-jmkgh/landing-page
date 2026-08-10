import { z } from 'zod';
import { normaliseLine, normaliseText } from '../../utils/text';

/**
 * Career application contract.
 *
 * `OPEN_POSITIONS` mirrors `frontend/src/lib/content/careers.ts` — the two lists must be
 * kept in step, and the server list is the one that decides what is accepted.
 */
export const OPEN_POSITIONS = [
  'CAD Trainers',
  'SAP Trainers',
  'Business Development Executives',
  'Telecallers',
  'Software Developers',
  'UI/UX Designers',
  'Digital Marketing Executives',
  'Export Executives',
  'Civil Engineers',
  'Mechanical Engineers',
  'Electrical Engineers',
  'Sales Executives',
  'HR Professionals',
] as const;

/**
 * Review states for an application. Separate from the enquiry states because the two
 * workflows are genuinely different — an application is shortlisted or hired, an
 * enquiry is not.
 */
export const APPLICATION_STATUSES = [
  'new',
  'reviewing',
  'shortlisted',
  'rejected',
  'hired',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Experience bands offered by the form. Kept short so the value stays reportable. */
export const EXPERIENCE_LEVELS = [
  'Fresher',
  'Less than 1 year',
  '1–3 years',
  '3–5 years',
  '5–10 years',
  'More than 10 years',
] as const;

const PHONE_PATTERN = /^[+]?[\d\s()-]{7,20}$/;

/**
 * Accepts an optional profile link.
 *
 * Only http(s) is allowed: a `javascript:` or `data:` value would otherwise be stored
 * and later rendered as a link in the admin area or an email.
 */
function optionalUrl(message: string) {
  return z
    .string()
    .max(255, 'That link is too long.')
    .optional()
    .transform((value) => {
      const cleaned = normaliseLine(value ?? '');
      return cleaned.length > 0 ? cleaned : null;
    })
    .refine(
      (value) => value === null || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(value),
      { message },
    );
}

export const applicationSchema = z.object({
  fullName: z
    .string({ required_error: 'Please enter your name.' })
    .transform(normaliseLine)
    .pipe(
      z
        .string()
        .min(2, 'Please enter your full name.')
        .max(120, 'Name must be 120 characters or fewer.'),
    ),

  email: z
    .string({ required_error: 'Please enter your email address.' })
    .transform((value) => normaliseLine(value).toLowerCase())
    .pipe(
      z.string().max(190, 'Email address is too long.').email('Please enter a valid email address.'),
    ),

  phone: z
    .string({ required_error: 'Please enter your phone number.' })
    .transform(normaliseLine)
    .pipe(
      z
        .string()
        .regex(PHONE_PATTERN, 'Please enter a valid phone number.')
        .refine((value) => {
          const digits = value.replace(/\D/g, '').length;
          return digits >= 7 && digits <= 15;
        }, 'Please enter a valid phone number.'),
    ),

  position: z.enum(OPEN_POSITIONS, {
    errorMap: () => ({ message: 'Please choose the position you are applying for.' }),
  }),

  message: z
    .string()
    .max(2000, 'Message must be 2000 characters or fewer.')
    .optional()
    .transform((value) => {
      if (!value) return null;
      const cleaned = normaliseText(value);
      return cleaned.length > 0 ? cleaned : null;
    }),

  linkedinUrl: optionalUrl('Please enter a full LinkedIn URL starting with https://'),
  portfolioUrl: optionalUrl('Please enter a full portfolio URL starting with https://'),

  /**
   * A multipart form always sends its optional fields, so an unselected dropdown
   * arrives as an empty string. `.optional()` alone accepts only `undefined`, which
   * would reject every application that skipped this field.
   */
  experience: z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
      z.enum(EXPERIENCE_LEVELS, {
        errorMap: () => ({ message: 'Please choose one of the listed experience levels.' }),
      }).optional(),
    )
    .transform((value) => value ?? null),

  location: z
    .string()
    .max(120, 'Location must be 120 characters or fewer.')
    .optional()
    .transform((value) => {
      const cleaned = normaliseLine(value ?? '');
      return cleaned.length > 0 ? cleaned : null;
    }),

  /** Honeypot — must stay empty. */
  website: z.string().optional().default(''),
  renderedAt: z.coerce.number().int().positive().optional(),
  /** reCAPTCHA v2 response token; enforced in the service layer. */
  recaptchaToken: z.string().max(4096).optional(),
});

export type ApplicationInput = z.infer<typeof applicationSchema>;

export const applicationStatusUpdateSchema = z.object({
  status: z.enum(APPLICATION_STATUSES, {
    errorMap: () => ({ message: 'Choose a valid status.' }),
  }),
});
