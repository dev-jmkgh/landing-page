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
  /*
   * The customer came to the office.
   *
   * Appended, not inserted where it belongs semantically (between `interested` and
   * `converted`), because MySQL stores an ENUM as an index into its value list — moving
   * an existing value would change the meaning of every row already stored. Display
   * order is decided by the UI, which is free to put it wherever it reads best.
   */
  'walked_in',
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

/**
 * `'missed','rejected','busy','unreachable','no_answer'`, for `c.outcome IN (...)`.
 *
 * Interpolated rather than bound, which is safe only because it is built from the
 * closed tuple above, never from input. One copy, so "not answered" cannot mean five
 * outcomes in one query and four in the next.
 */
export const UNANSWERED_SQL_LIST = UNANSWERED_OUTCOMES.map((outcome) => `'${outcome}'`).join(',');

/**
 * THE single definition of a call on the company line, as SQL.
 *
 * An outgoing call was dialled from the app, so it is company work by construction. An
 * incoming call counts only once the server has verified it arrived on the employee's
 * registered company SIM — `sim_match` is set then, and only then (migration 021).
 * Legacy incoming rows uploaded before that check existed keep `sim_match` NULL: they
 * stay in the table and in lead history, but every count, tile, report and incoming
 * list applies this predicate, so personal calls on a second SIM never reach them.
 *
 * `alias` is the calls table's alias in the surrounding query, written in code; pass
 * `''` for an unaliased `calls`.
 */
export function companyLineSql(alias = 'c'): string {
  if (alias !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid SQL alias for companyLineSql: ${JSON.stringify(alias)}`);
  }
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return `(${column('direction')} = 'outgoing' OR ${column('sim_match')} IS NOT NULL)`;
}

/**
 * How an incoming call's line was verified (`calls.sim_match`).
 *
 *   number      the handset read the SIM's own number and it matched the registered one
 *   confirmed   the employee confirmed this SIM as the company SIM on this handset
 *   single_sim  the call-log row named no SIM and the confirmed SIM was the only one
 *   provider    a telephony provider reported the number dialled
 */
export const SIM_MATCHES = ['number', 'confirmed', 'single_sim', 'provider'] as const;
export type SimMatch = (typeof SIM_MATCHES)[number];

/** The subset a handset may assert. `provider` is only ever set by the server. */
export const DEVICE_SIM_MATCHES = ['number', 'confirmed', 'single_sim'] as const;
export type DeviceSimMatch = (typeof DEVICE_SIM_MATCHES)[number];

/**
 * Which incoming calls a list shows. `company` (the default everywhere) applies
 * `companyLineSql`; `unverified` is the legacy rows nobody could verify, for admins who
 * need to look at them; `all` is both.
 */
export const CALL_LINES = ['company', 'unverified', 'all'] as const;
export type CallLine = (typeof CALL_LINES)[number];

/**
 * Why an uploaded incoming call was not stored. Returned to the app with a 200 — never
 * a 4xx, which older app builds treat as a permanent failure worth an alert.
 */
export const CALL_IGNORE_REASONS = [
  'line_unverified',
  'no_company_number',
  'stale_confirmation',
  'not_company_line',
  'other_employee_line',
] as const;
export type CallIgnoreReason = (typeof CALL_IGNORE_REASONS)[number];

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
 *
 * `completed_today` is the window over `state = 'completed'` that the dashboard's
 * "Completed today" card counts, so the card can open a list holding exactly its rows.
 * Appended, so a client that only knows the older values is unaffected.
 */
export const FOLLOW_UP_SCOPES = [
  'today',
  'upcoming',
  'overdue',
  'pending',
  'completed',
  'all',
  'completed_today',
] as const;
export type FollowUpScope = (typeof FOLLOW_UP_SCOPES)[number];

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The access ladder for the TELECALLING product.
 *
 * Note what is absent: there is no role here for staff who are not on the call floor.
 * An `employee` role was added for a short while so the HR app could register through
 * this signup, and migration 017 took it back out — HR accounts live in `hr_users` with
 * their own role set, because the two products answer different questions about a
 * person and a shared ladder forced one enum to mean both.
 *
 * The authority order lives in `RANK` in actor.ts, not in this tuple's order.
 */
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
  /*
   * A follow-up handed to another employee, and one moved in more than one way at once
   * (time and assignee, or onto another lead). Reassigning used to be logged as
   * `follow_up_rescheduled`, which told a reader the time had changed when it had not.
   * Both clients render only the summary, so an older build shows these lines as written.
   */
  'follow_up_moved',
  'follow_up_reassigned',
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

/**
 * Optional phone: an empty string becomes null rather than failing validation.
 *
 * NEVER USE IT BARE IN A PATCH SCHEMA — wrap it in `.optional()`. It turns an ABSENT key
 * into `null` as well, which is right on a create form and destructive on a partial
 * update: `{ isActive: false }` sent to a schema holding the bare field came out as
 * `{ isActive: false, phone: null }` and erased the stored number. `.optional()` returns
 * `undefined` for a missing key without running the transform, so absent means
 * "unchanged" and an explicit null still clears. The same holds for `optionalEmailField`,
 * `optionalLine` and `optionalBlock`.
 */
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

/**
 * The 10-digit national number of an Indian mobile, or null if `value` is not one.
 *
 * Accepts the shapes people actually type and handsets report — `+91 98765 00002`,
 * `919876500002`, `09876500002`, `98765-00002` — by stripping everything but digits,
 * then a leading `91` from twelve digits or a leading `0` from eleven. What remains
 * must be a mobile number (`[6-9]` then nine digits); a landline or a short code is not
 * a SIM anyone can be issued.
 *
 * This is the matching key for the company line: `telecaller_users.company_phone_key`
 * is the same last ten digits, computed in the database.
 */
export function companyPhoneKey(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/**
 * A company SIM number, required. Output is canonical `+91XXXXXXXXXX`.
 *
 * Canonicalised, unlike every other phone field here, because this one is a system
 * identifier the server matches calls against — not a number kept "as typed" for a
 * person to read back off a paper lead.
 */
export const companyPhoneField = z
  .string({
    required_error: 'Enter your company SIM number.',
    invalid_type_error: 'Enter your company SIM number.',
  })
  .transform(normaliseLine)
  .pipe(z.string().min(1, 'Enter your company SIM number.'))
  .transform((value, context) => {
    const key = companyPhoneKey(value);
    if (!key) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a 10-digit mobile number.' });
      return z.NEVER;
    }
    return `+91${key}`;
  });

/**
 * A company SIM number that may be cleared: `''` and `null` become null, anything else
 * must be a valid number.
 *
 * Deliberately has no answer for an absent key. Wrap it in `.optional()` at the use
 * site, so a PATCH that does not mention the number leaves it alone — see the warning
 * on `optionalPhoneField`.
 */
export const optionalCompanyPhoneField = z.union([
  z.literal('').transform(() => null),
  z.null(),
  companyPhoneField,
]);

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

/**
 * Inclusive date-range filter used by every admin report and dashboard.
 *
 * `from` and `to` are IST calendar days. Turn them into SQL with the helpers in
 * `companyTime.ts` (half-open instant bounds), never by appending `' 00:00:00'` — the
 * columns hold UTC, so that reads the range five and a half hours early.
 */
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
