import { z } from 'zod';
import { normaliseLine, normaliseText } from '../../utils/text';

/**
 * Server-side contract for the enquiry endpoint. The browser runs equivalent checks for
 * fast feedback, but this schema is the only one that decides what is stored.
 */

export const INTEREST_OPTIONS = [
  'JMK Academy',
  'JMK Design Studio',
  'JMK Software Solutions',
  'Export Business',
  'Agriculture',
  'Renewable Energy',
  'Other',
] as const;

export const ENQUIRY_SOURCES = ['floating-widget', 'contact-page', 'business-page'] as const;

const PHONE_PATTERN = /^[+]?[\d\s()-]{7,20}$/;

const nameField = z
  .string({ required_error: 'Please enter your name.' })
  .transform(normaliseLine)
  .pipe(
    z
      .string()
      .min(2, 'Please enter your full name.')
      .max(120, 'Name must be 120 characters or fewer.'),
  );

const emailField = z
  .string({ required_error: 'Please enter your email address.' })
  .transform((value) => normaliseLine(value).toLowerCase())
  .pipe(
    z
      .string()
      .max(190, 'Email address is too long.')
      .email('Please enter a valid email address.'),
  );

const phoneField = z
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
  );

const messageField = z
  .string({ required_error: 'Please tell us how we can help.' })
  .transform(normaliseText)
  .pipe(
    z
      .string()
      .min(10, 'Please write at least 10 characters.')
      .max(2000, 'Message must be 2000 characters or fewer.'),
  );

export const enquirySchema = z.object({
  name: nameField,
  email: emailField,
  phone: phoneField,
  company: z
    .string()
    .max(150, 'Company name must be 150 characters or fewer.')
    .transform((value) => {
      const cleaned = normaliseLine(value);
      return cleaned.length > 0 ? cleaned : null;
    })
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  interestedIn: z.enum(INTEREST_OPTIONS, {
    errorMap: () => ({ message: 'Please choose what you are interested in.' }),
  }),
  message: messageField,
  source: z.enum(ENQUIRY_SOURCES).catch('floating-widget'),

  /** Honeypot — must stay empty. */
  website: z.string().optional().default(''),
  /** Epoch milliseconds recorded when the form was rendered. */
  renderedAt: z.coerce.number().int().positive().optional(),
});

export type EnquiryInput = z.infer<typeof enquirySchema>;

export const ENQUIRY_STATUSES = ['new', 'contacted', 'in_progress', 'closed'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const statusUpdateSchema = z.object({
  status: z.enum(ENQUIRY_STATUSES, {
    errorMap: () => ({ message: 'Choose a valid status.' }),
  }),
});

export const listQuerySchema = z.object({
  status: z.enum(ENQUIRY_STATUSES).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListQuery = z.infer<typeof listQuerySchema>;
