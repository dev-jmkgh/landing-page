import { z } from 'zod';
import {
  CALL_CHANNELS,
  CALL_DIRECTIONS,
  CALL_OUTCOMES,
  CALL_SOURCES,
  clientUuidField,
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
   */
  leadStatus: z.enum(LEAD_STATUSES).optional(),

  /** Follow-up booked from the post-call sheet. */
  followUpAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable()
    .transform((value) => (value ? new Date(value) : null)),
  followUpNote: optionalLine(1000),

  clientUuid: clientUuidField,
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

export const callListQuerySchema = paginationSchema.extend({
  leadId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  direction: z.enum(CALL_DIRECTIONS).optional(),
  outcome: z.enum(CALL_OUTCOMES).optional(),
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
  from: z.string().date('Expected YYYY-MM-DD.').optional(),
  to: z.string().date('Expected YYYY-MM-DD.').optional(),
});

export type CallListQuery = z.infer<typeof callListQuerySchema>;

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
