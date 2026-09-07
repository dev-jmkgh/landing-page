import { z } from 'zod';
import { normaliseLine } from '../../../utils/text';
import {
  clientUuidField,
  LEAD_STATUSES,
  optionalBlock,
  optionalEmailField,
  optionalLine,
  optionalPhoneField,
  paginationSchema,
  phoneField,
} from '../shared.schema';

/**
 * Request contracts for leads (spec: Mobile Modules 3, 4, 9 and Admin Modules 4, 5).
 */

const customerNameField = z
  .string({ required_error: 'Enter the customer name.' })
  .transform(normaliseLine)
  .pipe(
    z
      .string()
      .min(2, 'Enter the customer name.')
      .max(120, 'Name must be 120 characters or fewer.'),
  );

/**
 * Source is a free string, not an enum.
 *
 * `lead_sources` is a table admins extend from the settings screen. Validating against
 * a hard-coded list here would mean adding a source through the UI and then finding
 * that leads cannot be created with it — the failure would appear in a different part
 * of the system from the change that caused it. The service checks the value against
 * the table instead, which is the thing that can actually be right.
 */
const sourceField = z
  .string()
  .transform((value) => normaliseLine(value).toLowerCase().replace(/[\s-]+/g, '_'))
  .pipe(
    z
      .string()
      .min(2, 'Choose a lead source.')
      .max(40, 'Source must be 40 characters or fewer.')
      .regex(/^[a-z0-9_]+$/, 'Use letters, numbers and underscores only.'),
  )
  .default('manual');

export const createLeadSchema = z.object({
  customerName: customerNameField,
  phone: phoneField,
  alternatePhone: optionalPhoneField,
  email: optionalEmailField,
  address: optionalLine(500, 'Address must be 500 characters or fewer.'),
  city: optionalLine(120),
  source: sourceField,
  productInterest: optionalLine(190),
  status: z.enum(LEAD_STATUSES).default('new'),
  summaryNote: optionalBlock(4000, 'Notes must be 4000 characters or fewer.'),

  /**
   * Who the lead belongs to.
   *
   * Ignored for a telecaller, who always gets their own id — see the service. Only a
   * supervisor and above can assign to someone else.
   */
  assignedTo: z.coerce.number().int().positive().nullable().optional(),

  /**
   * Set when a website enquiry is being promoted into a lead, so the same customer is
   * not worked twice from two systems.
   */
  enquiryId: z.coerce.number().int().positive().nullable().optional(),

  /**
   * Storage key for a photo of a paper lead (spec: Module 4). Uploaded through the
   * dedicated attachment endpoint first, which returns this key.
   */
  attachmentKey: optionalLine(255),

  clientUuid: clientUuidField,
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/**
 * Update.
 *
 * `.partial()` is not used: every field has to be individually optional *and* keep its
 * empty-string-to-null transform, which `.partial()` on a transformed field does not
 * preserve. Status has its own endpoint — it is the single most audited change on a
 * lead and it drives activity, conversion timestamps and the follow-up prompt, so it
 * does not belong in a generic field update.
 */
export const updateLeadSchema = z
  .object({
    customerName: customerNameField.optional(),
    phone: phoneField.optional(),
    alternatePhone: optionalPhoneField,
    email: optionalEmailField,
    address: optionalLine(500),
    city: optionalLine(120),
    source: sourceField.optional(),
    productInterest: optionalLine(190),
    summaryNote: optionalBlock(4000),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update.',
  });

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

/**
 * Status change.
 *
 * `followUpAt` is accepted alongside the status because the two nearly always happen
 * together: marking a lead `follow_up` or `callback_requested` without booking the
 * follow-up is the most common way for a lead to go quiet. Making it one request means
 * one round trip from a phone on a bad connection, and one entry in the offline queue
 * that cannot half-apply.
 */
export const leadStatusSchema = z.object({
  status: z.enum(LEAD_STATUSES),
  note: optionalBlock(2000),
  followUpAt: z
    .string()
    .datetime({ offset: true, message: 'Expected an ISO-8601 timestamp.' })
    .optional()
    .nullable()
    .transform((value) => (value ? new Date(value) : null)),
  followUpNote: optionalLine(1000),
  clientUuid: clientUuidField,
});

export type LeadStatusInput = z.infer<typeof leadStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Assignment                                                                  */
/* -------------------------------------------------------------------------- */

export const assignLeadSchema = z.object({
  /** `null` unassigns, returning the lead to the pool. */
  assignedTo: z.coerce.number().int().positive().nullable(),
  reason: optionalLine(255),
});

/**
 * Bulk assignment (spec: Admin Module 5).
 *
 * Capped at 500 ids. The whole operation runs in one transaction so a partial assignment
 * cannot leave half a batch owned by nobody, and a transaction that large is already at
 * the edge of what should hold locks on the leads table during working hours.
 */
export const bulkAssignSchema = z.object({
  leadIds: z
    .array(z.coerce.number().int().positive())
    .min(1, 'Select at least one lead.')
    .max(500, 'Assign at most 500 leads at a time.'),
  assignedTo: z.coerce.number().int().positive().nullable(),
  reason: optionalLine(255),
});

export type BulkAssignInput = z.infer<typeof bulkAssignSchema>;

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

export const leadNoteSchema = z.object({
  body: z
    .string({ required_error: 'Write a note.' })
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, 'Write a note.')
        .max(4000, 'Note must be 4000 characters or fewer.'),
    ),
  kind: z.enum(['note', 'requirement', 'call_note']).default('note'),
  callId: z.coerce.number().int().positive().nullable().optional(),
  clientUuid: clientUuidField,
});

export type LeadNoteInput = z.infer<typeof leadNoteSchema>;

/* -------------------------------------------------------------------------- */
/* Listing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How a lead list is sorted.
 *
 * A closed set rather than a free column name, because the value is interpolated into
 * an ORDER BY clause where a bound parameter is not accepted.
 */
export const LEAD_SORTS = [
  'recent',
  'oldest',
  'name',
  'follow_up',
  'last_contacted',
  'never_contacted',
] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];

export const leadListQuerySchema = paginationSchema.extend({
  status: z.enum(LEAD_STATUSES).optional(),
  source: z.string().trim().max(40).optional(),
  /**
   * `unassigned` is a distinct filter value, not the absence of one: the admin
   * assignment screen is built around the unassigned queue, and `assignedTo` omitted
   * has to keep meaning "any owner".
   */
  assignedTo: z
    .union([z.literal('unassigned'), z.coerce.number().int().positive()])
    .optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(LEAD_SORTS).default('recent'),
  archived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? false : value === 'true')),
  from: z.string().date('Expected YYYY-MM-DD.').optional(),
  to: z.string().date('Expected YYYY-MM-DD.').optional(),
});

export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

/**
 * Lookup by phone number, used when a telecaller's handset rings with an unknown
 * number and the app needs to know whose lead it is.
 */
export const leadLookupSchema = z.object({
  phone: z.string().trim().min(4).max(20),
});
