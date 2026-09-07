import { z } from 'zod';
import { normaliseLine, normaliseText } from '../../utils/text';

/**
 * The telecalling vocabulary.
 *
 * These tuples are the contract between the database ENUMs, this API, the admin web
 * app and the mobile app. Adding a value means a migration and a change in both
 * clients — treat them as public API, not as an implementation detail.
 *
 * They live in one file rather than in each feature module because several modules
 * need the same ones (a call updates a lead status, a report groups by it) and a second
 * copy would be a second thing to forget to update.
 */

/* -------------------------------------------------------------------------- */
/* Leads                                                                       */
/* -------------------------------------------------------------------------- */

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'interested',
  'not_interested',
  'follow_up',
  'callback_requested',
  'converted',
  'lost',
  'invalid_number',
  'not_reachable',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * Statuses that mean the conversation is over. Used by reporting and by the
 * "still to work" counts, so that a converted lead does not sit in an employee's
 * pending queue forever.
 */
export const CLOSED_LEAD_STATUSES: readonly LeadStatus[] = [
  'converted',
  'lost',
  'not_interested',
  'invalid_number',
];

/**
 * Seeded sources. `lead_sources` is a table an admin can extend, so this is the set the
 * clients know how to label — not a whitelist. An unrecognised slug is accepted and
 * shown verbatim rather than rejected, otherwise adding a source through the admin UI
 * would immediately break lead creation.
 */
export const LEAD_SOURCES = [
  'website',
  'advertisement',
  'referral',
  'manual',
  'hard_copy',
  'other',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/* -------------------------------------------------------------------------- */
/* Calls                                                                       */
/* -------------------------------------------------------------------------- */

export const CALL_DIRECTIONS = ['outgoing', 'incoming'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export const CALL_OUTCOMES = [
  'answered',
  'missed',
  'rejected',
  'busy',
  'unreachable',
  'no_answer',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** Outcomes where the customer was not actually spoken to. */
export const UNANSWERED_OUTCOMES: readonly CallOutcome[] = [
  'missed',
  'rejected',
  'busy',
  'unreachable',
  'no_answer',
];

/** How the call was placed. See the telecalling-spec skill for why both exist. */
export const CALL_CHANNELS = ['device', 'cloud'] as const;
export type CallChannel = (typeof CALL_CHANNELS)[number];

/**
 * Where the call's numbers came from — read from the Android call log, confirmed by the
 * telecaller (the only option on iOS), or reported by a telephony provider. Reporting
 * needs this to know which figures are measured and which are self-reported.
 */
export const CALL_SOURCES = ['call_log', 'manual', 'provider'] as const;
export type CallSource = (typeof CALL_SOURCES)[number];

/* -------------------------------------------------------------------------- */
/* Follow-ups                                                                  */
/* -------------------------------------------------------------------------- */

export const FOLLOW_UP_STATES = ['pending', 'completed', 'cancelled'] as const;
export type FollowUpState = (typeof FOLLOW_UP_STATES)[number];

/**
 * How a client asks for a slice of the follow-up list.
 *
 * `overdue` and `today` are not stored states — they are date windows applied to
 * `state = 'pending'`. Expressing them as a scope keeps that arithmetic in one place
 * instead of in every screen that shows a follow-up list.
 */
export const FOLLOW_UP_SCOPES = [
  'today',
  'upcoming',
  'overdue',
  'pending',
  'completed',
  'all',
] as const;
export type FollowUpScope = (typeof FOLLOW_UP_SCOPES)[number];

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

export const EMPLOYEE_ROLES = ['admin', 'manager', 'supervisor', 'telecaller'] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export const AVAILABILITY_STATES = ['available', 'busy', 'on_break', 'offline'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export const DEVICE_PLATFORMS = ['android', 'ios', 'unknown'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/* -------------------------------------------------------------------------- */
/* Activity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Known `lead_activities.type` values. The column is a VARCHAR so a new kind does not
 * cost a migration, but the write path validates against this list — an unrecognised
 * type would render as a blank row in both clients' timelines.
 */
export const ACTIVITY_TYPES = [
  'lead_created',
  'lead_updated',
  'lead_assigned',
  'lead_reassigned',
  'lead_unassigned',
  'status_changed',
  'call_logged',
  'recording_attached',
  'note_added',
  'follow_up_created',
  'follow_up_completed',
  'follow_up_rescheduled',
  'follow_up_cancelled',
  'lead_archived',
  'lead_restored',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* Reusable field builders                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Phone numbers are stored as entered, not normalised to E.164.
 *
 * Telecallers type local numbers, and rewriting them would make the number in the app
 * differ from the number on the paper lead the customer is holding. Matching against a
 * call log strips non-digits and compares the last nine digits instead — see
 * `digitsOnly`.
 */
const PHONE_PATTERN = /^[+]?[\d\s()-]{7,20}$/;

export const phoneField = z
  .string({ required_error: 'Enter a phone number.' })
  .transform(normaliseLine)
  .pipe(
    z
      .string()
      .regex(PHONE_PATTERN, 'Enter a valid phone number.')
      .refine((value) => {
        const digits = value.replace(/\D/g, '').length;
        return digits >= 7 && digits <= 15;
      }, 'Enter a valid phone number.'),
  );

/** Optional phone: an empty string becomes null rather than failing validation. */
export const optionalPhoneField = z
  .string()
  .transform(normaliseLine)
  .transform((value) => (value.length > 0 ? value : null))
  .nullable()
  .optional()
  .transform((value) => value ?? null)
  .pipe(
    z
      .string()
      .regex(PHONE_PATTERN, 'Enter a valid phone number.')
      .nullable(),
  );

export const optionalEmailField = z
  .string()
  .transform((value) => normaliseLine(value).toLowerCase())
  .transform((value) => (value.length > 0 ? value : null))
  .nullable()
  .optional()
  .transform((value) => value ?? null)
  .pipe(z.string().max(190).email('Enter a valid email address.').nullable());

/** Single-line optional text, trimmed, empty becomes null. */
export function optionalLine(maxLength: number, message?: string) {
  return z
    .string()
    .transform(normaliseLine)
    .transform((value) => (value.length > 0 ? value : null))
    .nullable()
    .optional()
    .transform((value) => value ?? null)
    .pipe(z.string().max(maxLength, message ?? `Must be ${maxLength} characters or fewer.`).nullable());
}

/** Multi-line optional text, newlines preserved, empty becomes null. */
export function optionalBlock(maxLength: number, message?: string) {
  return z
    .string()
    .transform(normaliseText)
    .transform((value) => (value.length > 0 ? value : null))
    .nullable()
    .optional()
    .transform((value) => value ?? null)
    .pipe(z.string().max(maxLength, message ?? `Must be ${maxLength} characters or fewer.`).nullable());
}

/**
 * Idempotency key from the mobile offline queue.
 *
 * The mobile app writes every mutation to a local queue and drains it when the network
 * returns. A retry after an ambiguous timeout must not create a second call row, so the
 * client generates this id before the first attempt and reuses it on every retry.
 */
export const clientUuidField = z
  .string()
  .uuid('clientUuid must be a UUID.')
  .optional()
  .nullable()
  .transform((value) => value ?? null);

/**
 * An ISO-8601 timestamp from a client, as a Date.
 *
 * `z.coerce.date()` accepts far too much (a bare number becomes an epoch date), so the
 * string is checked first. The mobile app sends timestamps recorded while offline, so
 * these are frequently in the past by hours — that is expected, not an error.
 */
export const isoDateField = z
  .string()
  .datetime({ offset: true, message: 'Expected an ISO-8601 timestamp.' })
  .transform((value) => new Date(value));

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Base list query shared by every telecalling listing.
 *
 * `page`/`pageSize` are bounded here because the repository interpolates them straight
 * into LIMIT/OFFSET — MySQL prepared statements do not take placeholders there
 * reliably, so this schema is the only thing standing between a client and an
 * unbounded scan.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Inclusive date-range filter used by every admin report and dashboard. */
export const dateRangeSchema = z.object({
  from: z.string().date('Expected YYYY-MM-DD.').optional(),
  to: z.string().date('Expected YYYY-MM-DD.').optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;
export type DateRange = z.infer<typeof dateRangeSchema>;

export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

/**
 * Clamps a requested page against the row count that actually exists.
 *
 * Asking for page 400 of a 3-page list should return the last page, not an empty one:
 * an empty result is indistinguishable from "no records" in the UI, and a client that
 * has just had rows deleted underneath it would show nothing at all.
 */
export function resolvePage(
  filters: Pagination,
  total: number,
): { page: number; pageSize: number; offset: number; totalPages: number } {
  const pageSize = Math.min(Math.max(Math.trunc(filters.pageSize), 1), 100);
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(Math.trunc(filters.page), 1), totalPages);
  return { page, pageSize, offset: (page - 1) * pageSize, totalPages };
}

/** Escapes LIKE wildcards so a search for "50%" does not match every row. */
export function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** Reduces a phone number to digits, for comparison rather than for storage. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * The trailing digits used to match a dialled number against a stored one.
 *
 * A telecaller may store `98765 43210` and the call log report `+919876543210`. Nine
 * digits is long enough to be unambiguous in practice and short enough to survive a
 * missing country code or a leading zero.
 */
export function phoneMatchKey(value: string): string {
  const digits = digitsOnly(value);
  return digits.length > 9 ? digits.slice(-9) : digits;
}
