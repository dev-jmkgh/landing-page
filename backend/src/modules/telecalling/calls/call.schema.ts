import { z } from 'zod';
import { normaliseLine } from '../../../utils/text';
import {
  CALL_CHANNELS,
  CALL_DIRECTIONS,
  CALL_LINES,
  CALL_OUTCOMES,
  CALL_SOURCES,
  clientUuidField,
  DEVICE_SIM_MATCHES,
  isoDateField,
  LEAD_STATUSES,
  optionalBlock,
  optionalLine,
  paginationSchema,
  phoneField,
} from '../shared.schema';

/**
 * Request contracts for calls (spec: Mobile Modules 5, 6, 7 and Admin Modules 6, 7).
 */

/**
 * The handset's evidence of WHICH line received an incoming call.
 *
 * Evidence, not a verdict. The server owns the company number (`telecaller_users.
 * company_phone`) and re-checks this against it on every upload — see `verifyCompanyLine`
 * — so all a handset can do here is say which local SIM it matched to that number, and
 * against which number it made the match:
 *
 *   match         how the SIM was identified: its own number matched, the employee chose
 *                 it, or it is the only SIM and the call-log row named none
 *   confirmedFor  the 10-digit company number the handset's choice was made against. A
 *                 choice made against a number the admin has since changed is stale.
 *   simNumber     the SIM's own number, when the handset can read it — so a colleague's
 *                 company SIM in the same phone is recognised and refused
 *   slot, label   which SIM it was, for the employee's own benefit; not stored
 *
 * The informational fields are lenient on purpose (an unusable value becomes null) and
 * the object as a whole falls back to "no evidence" where `logCallSchema` uses it. The
 * reason is the offline queue: a 4xx tells the app the item can never be sent, so it is
 * dropped with an alert telling the employee something they saved was lost — for a call
 * the app read out of the call log on its own, which nobody typed. A slot of -1 from a
 * handset with an eSIM must not cost the call; evidence that cannot be used is answered
 * with a 200 that says the call was set aside, and why.
 */
export const callLineSchema = z.object({
  match: z.enum(DEVICE_SIM_MATCHES),
  confirmedFor: z.string().regex(/^\d{10}$/),
  simNumber: z
    .string()
    .regex(/^\d{6,15}$/)
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  slot: z
    .number()
    .int()
    .min(0)
    .max(7)
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  label: z
    .string()
    .nullish()
    .catch(null)
    .transform((value) => (value ? normaliseLine(value).slice(0, 60) || null : null)),
});

export type CallLineInput = z.infer<typeof callLineSchema>;

/**
 * A logged call.
 *
 * `startedAt` is required and comes from the client, not from the server clock. The
 * mobile app records calls while offline and drains them later, so a server timestamp
 * would file yesterday's evening calls under this morning and quietly corrupt every
 * daily report.
 *
 * `durationSeconds` is capped at eight hours. Not a business rule — a guard against the
 * Android call-log reader matching the wrong entry and reporting a duration measured
 * from the epoch, which would swamp every talk-time average on the dashboard.
 */
export const logCallSchema = z.object({
  leadId: z.coerce.number().int().positive().nullable().optional(),
  phone: phoneField,
  direction: z.enum(CALL_DIRECTIONS).default('outgoing'),
  outcome: z.enum(CALL_OUTCOMES),
  channel: z.enum(CALL_CHANNELS).default('device'),
  source: z.enum(CALL_SOURCES).default('manual'),
  durationSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .max(28_800, 'That duration is implausible. Check the call log entry.')
    .default(0),
  startedAt: isoDateField,
  endedAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable()
    .transform((value) => (value ? new Date(value) : null)),

  /** Post-call note, written in the same request so it cannot be lost separately. */
  note: optionalBlock(4000),

  /**
   * Status the telecaller chose in the post-call sheet. Applied to the lead in the same
   * transaction as the call, because "logged the call but lost the status" is the
   * failure that makes a telecaller stop trusting the app.
   *
   * `.nullish()` for the reason given on `recordCallSchema`: an unselected status is
   * `null` in the app and `.optional()` rejects that. `PostCallGate` has been converting
   * it to `undefined` on the way out to compensate, which worked only because there was
   * exactly one caller — the second one hit the error.
   */
  leadStatus: z.enum(LEAD_STATUSES).nullish(),

  /** Follow-up booked from the post-call sheet. */
  followUpAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable()
    .transform((value) => (value ? new Date(value) : null)),
  followUpNote: optionalLine(1000),

  clientUuid: clientUuidField,

  /**
   * Which line received an incoming call. Required in substance for every incoming call
   * — without usable evidence the call is set aside (200, `ignored`), never stored — but
   * optional on the wire, because builds from before the company-SIM check send none and
   * their queues must still drain. Ignored on an outgoing call: one dialled from the app
   * is company work by construction.
   */
  line: callLineSchema
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
});

export type LogCallInput = z.infer<typeof logCallSchema>;

/**
 * Batch upload from the offline queue.
 *
 * Capped at 100. A telecaller who spent a day out of signal has tens of calls, not
 * thousands, and a bounded batch keeps one bad request from holding a transaction open
 * across the whole table.
 */
export const logCallBatchSchema = z.object({
  calls: z
    .array(logCallSchema)
    .min(1, 'Send at least one call.')
    .max(100, 'Send at most 100 calls per request.'),
});

export type LogCallBatchInput = z.infer<typeof logCallBatchSchema>;

/** Marks a missed call as dealt with (spec: Module 7 tracks exactly this). */
export const resolveMissedCallSchema = z.object({
  followedUp: z.boolean().default(true),
});

/**
 * What a call list's outcome filter accepts: one outcome, or `unanswered` for every one of
 * UNANSWERED_OUTCOMES at once.
 *
 * The group value exists because the dashboard's "Not answered" card counts all five.
 * Opening that card onto `outcome=missed` would list a fraction of what it counted, and a
 * card whose list disagrees with it teaches people to distrust both.
 */
export const CALL_OUTCOME_FILTERS = [...CALL_OUTCOMES, 'unanswered'] as const;
export type CallOutcomeFilter = (typeof CALL_OUTCOME_FILTERS)[number];

export const callListQuerySchema = paginationSchema.extend({
  leadId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  direction: z.enum(CALL_DIRECTIONS).optional(),
  outcome: z.enum(CALL_OUTCOME_FILTERS).optional(),
  channel: z.enum(CALL_CHANNELS).optional(),
  /** Only calls that have a recording — the admin recordings screen. */
  withRecording: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  /** Unresolved missed/rejected calls — the callback queue. */
  pendingCallback: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  q: z.string().trim().max(120).optional(),
  /** Inclusive IST calendar days on `started_at` (see companyTime.ts). */
  from: z.string().date('Expected YYYY-MM-DD.').optional(),
  to: z.string().date('Expected YYYY-MM-DD.').optional(),
  /**
   * Which incoming calls to include, by the line that received them. `company` — every
   * outgoing call plus incoming calls verified on the company SIM — is the default, so a
   * client that never heard of this parameter (an older app build) gets the safe list.
   * `unverified` is the incoming rows saved before the check existed, for an admin who
   * needs to look at them; `all` is both.
   */
  line: z.enum(CALL_LINES).default('company'),
});

export type CallListQuery = z.infer<typeof callListQuerySchema>;

/* -------------------------------------------------------------------------- */
/* My activity: the employee's own calls, paged by cursor                      */
/* -------------------------------------------------------------------------- */

/** The position after which the next page starts: the last row shown, by its sort key. */
export type CallCursor = { startedAt: Date; id: number };

const CURSOR_MESSAGE = 'Could not load more calls. Pull down to refresh.';

/**
 * A page cursor as the client holds it: base64url of `{"s": <ISO startedAt>, "i": <id>}`.
 *
 * Opaque to the client, which passes back exactly what it was given. Readable rather
 * than signed, because it grants nothing — the list is always scoped to the signed-in
 * employee, so a forged cursor can only skip around their own calls.
 */
export function encodeCallCursor(position: { startedAt: string; id: number }): string {
  return Buffer.from(JSON.stringify({ s: position.startedAt, i: position.id }), 'utf8').toString(
    'base64url',
  );
}

/** The cursor's position, or null for anything this server did not produce. */
export function decodeCallCursor(value: string): CallCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;

    const { s, i } = parsed as { s?: unknown; i?: unknown };
    if (typeof s !== 'string' || typeof i !== 'number' || !Number.isSafeInteger(i) || i <= 0) {
      return null;
    }

    const startedAt = new Date(s);
    return Number.isNaN(startedAt.getTime()) ? null : { startedAt, id: i };
  } catch {
    return null;
  }
}

/** Hard ceiling on one page of My activity. Bounded here because it is interpolated. */
export const MY_CALLS_MAX_PAGE = 50;

/**
 * GET /mobile/activity/calls.
 *
 * Keyset-paged (`cursor`), not page-numbered. Calls arrive at the top of this list all
 * day — the incoming import runs every time the employee returns to the app — and a
 * numbered page shifts under the reader when they do, repeating rows at the top of the
 * next page or skipping them. Paging after the last row seen cannot do either.
 *
 * `linked` is the Leads / Unlinked filter: whether the call is filed against a lead.
 * `counts` (one figure per filter chip) is computed only when asked for and only on a
 * first page, because it is a second query and the chips do not change while scrolling.
 */
export const myCallListQuerySchema = z
  .object({
    direction: z.enum(CALL_DIRECTIONS).optional(),
    linked: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    outcome: z.enum(CALL_OUTCOME_FILTERS).optional(),
    /** Name, reference or phone digits — the same rule as the other call lists. */
    q: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((value) => (value ? value : undefined)),
    /** Inclusive IST calendar days on `started_at`. */
    from: z.string().date('Expected YYYY-MM-DD.').optional(),
    to: z.string().date('Expected YYYY-MM-DD.').optional(),
    /**
     * The previous page's `nextCursor`, unchanged. A value this server did not produce is
     * refused (422) rather than read as "start again", which would silently show the
     * first page twice — the message is worded for the person holding the phone.
     */
    cursor: z
      .string()
      .max(200, CURSOR_MESSAGE)
      .optional()
      .transform((value, context) => {
        if (value === undefined || value === '') return null;
        const decoded = decodeCallCursor(value);
        if (!decoded) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: CURSOR_MESSAGE });
          return z.NEVER;
        }
        return decoded;
      }),
    limit: z.coerce.number().int().min(1).max(MY_CALLS_MAX_PAGE).default(25),
    withCounts: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start date must be on or before the end date.',
    path: ['to'],
  });

export type MyCallListQuery = z.infer<typeof myCallListQuerySchema>;

/**
 * A call's own client id, as it appears in `/calls/by-client/:clientUuid/record`.
 * Anything that is not a UUID cannot name a call, so it is answered as one that does not
 * exist (404), never as a validation error about a path segment.
 */
export const callClientUuidParam = z.string().uuid();

/* -------------------------------------------------------------------------- */
/* Recordings                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A recording arriving from a telephony provider webhook.
 *
 * There is no device-upload variant, because Android 10+ and every iOS version block
 * third-party call recording — see the telecalling-spec skill. The column allows
 * `origin: 'device'` so the schema does not have to change if that ever becomes
 * possible, but nothing writes it today.
 */
export const attachRecordingSchema = z.object({
  callId: z.coerce.number().int().positive().optional(),
  /** Provider's call id, for when the webhook arrives before the call has been logged. */
  providerCallSid: optionalLine(120),
  storageKey: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(100).default('audio/mpeg'),
  sizeBytes: z.coerce.number().int().min(0).default(0),
  durationSeconds: z.coerce.number().int().min(0).max(28_800).default(0),
  provider: optionalLine(40),
});

export type AttachRecordingInput = z.infer<typeof attachRecordingSchema>;

/* -------------------------------------------------------------------------- */
/* Writing up a call that already exists                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a telecaller adds to an incoming call the app detected on its own.
 *
 * Every field is optional, and that is the difference from `logCallSchema`. Logging a
 * call asserts that it happened, so it needs the number, the outcome and the time.
 * Writing one up only amends a row that already carries all three — so an employee who
 * opens the sheet, changes nothing and saves has still done something meaningful: the
 * call is confirmed and marked recorded.
 */
export const recordCallSchema = z.object({
  /**
   * The lead this call belongs to, for a caller the server could not place.
   *
   * Honoured only when the call has no lead yet; the service will not move a call between
   * customers. Omitted for a call that already matched one, which is the common case.
   */
  leadId: z.coerce.number().int().positive().nullable().optional(),

  /** The telecaller correcting what the call log reported. */
  outcome: z.enum(CALL_OUTCOMES).optional(),
  durationSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .max(28_800, 'That duration is implausible. Check the call log entry.')
    .optional(),

  note: optionalBlock(4000),
  /**
   * `.nullish()`, not `.optional()`.
   *
   * A client with no status to set says so with `null` — that is what an unselected chip
   * is in the app's own state, and what JSON carries. `.optional()` accepts `undefined`
   * and REJECTS `null`, so the natural request was answered with a validation error
   * naming a field the telecaller never touched, and the whole write-up was lost.
   *
   * Both meanings are "leave the status alone", which is what the service does with a
   * falsy value, so accepting both is not leniency — it is the schema describing the two
   * ways callers already express the same thing.
   */
  leadStatus: z.enum(LEAD_STATUSES).nullish(),

  followUpAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable()
    .transform((value) => (value ? new Date(value) : null)),
  followUpNote: optionalLine(1000),

  /**
   * Idempotency key of THIS write-up — minted once per save on the handset and reused on
   * every retry of it, so a retried save applies once. Stored on the call
   * (`record_client_uuid`); a later save of the same call carries a new key and applies.
   *
   * Optional, because builds from before write-ups were queued send none. Those behave
   * as they always did: each request applies.
   */
  clientUuid: clientUuidField,
});

export type RecordCallInput = z.infer<typeof recordCallSchema>;
