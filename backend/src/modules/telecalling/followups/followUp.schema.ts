import { z } from 'zod';
import {
  clientUuidField,
  FOLLOW_UP_SCOPES,
  optionalLine,
  paginationSchema,
} from '../shared.schema';

/**
 * Request contracts for follow-ups (spec: Mobile Module 8, Admin Module 8).
 */

/**
 * How far a follow-up's time may be from now, as numbers — shared by the field below and
 * by the move, which applies them in the service, only when the time actually changes
 * (something a schema cannot know; see `moveFollowUpSchema`).
 */
export const FOLLOW_UP_PAST_SLACK_MS = 60_000;
export const FOLLOW_UP_HORIZON_MS = 2 * 365 * 86_400_000;

/**
 * A follow-up must be in the future — with a minute of slack.
 *
 * The slack matters: a phone that has been offline sends a follow-up it created ten
 * seconds ago, and clock skew between a handset and the server is routinely a few
 * seconds. Rejecting those would fail the sync for a follow-up the telecaller correctly
 * booked for later today.
 *
 * Exported for the handover's "move them all to" time, which is held to the same rule.
 */
export const futureDueAtField = z
  .string({ required_error: 'Choose when to follow up.' })
  .datetime({ offset: true, message: 'Expected an ISO-8601 timestamp.' })
  .transform((value) => new Date(value))
  .refine((value) => value.getTime() > Date.now() - FOLLOW_UP_PAST_SLACK_MS, {
    message: 'Choose a time in the future.',
  })
  .refine((value) => value.getTime() < Date.now() + FOLLOW_UP_HORIZON_MS, {
    // A follow-up two years out is a typo in the year, not a plan.
    message: 'That date is too far in the future.',
  });

/**
 * Cuts an instant to its whole minute.
 *
 * The admin screens offer hours and minutes, so a seconds part is something nobody chose
 * and nobody can see — and two follow-ups both shown as "10:00" must not be two different
 * times. IST is a whole number of minutes from UTC, so the UTC minute is the IST minute.
 */
export function toWholeMinute(value: Date): Date {
  const minute = new Date(value.getTime());
  minute.setUTCSeconds(0, 0);
  return minute;
}

export const createFollowUpSchema = z.object({
  leadId: z.coerce.number().int().positive(),
  dueAt: futureDueAtField,
  note: optionalLine(1000),
  /**
   * Only a supervisor and above may book a follow-up for someone else. For a telecaller
   * the field is ignored and they get their own id — see the service.
   */
  assignedTo: z.coerce.number().int().positive().optional(),
  clientUuid: clientUuidField,
});

export type CreateFollowUpInput = z.infer<typeof createFollowUpSchema>;

/**
 * Reschedule.
 *
 * A distinct operation from "edit", not a field update. It keeps one row and moves
 * `due_at`, recording where it came from, so the timeline can say "moved from Tuesday"
 * instead of showing a cancelled follow-up beside a new one — and so `reschedule_count`
 * can answer "how many times has this been put off", which is the question a manager
 * actually asks.
 */
export const rescheduleFollowUpSchema = z.object({
  dueAt: futureDueAtField,
  note: optionalLine(1000),
});

export const completeFollowUpSchema = z.object({
  outcomeNote: optionalLine(1000),
  clientUuid: clientUuidField,
});

/**
 * Edit: the note, or who holds the follow-up.
 *
 * `note` is wrapped in `.optional()` so an ABSENT key means "unchanged". Bare,
 * `optionalLine` turns a missing key into null, so `{ assignedTo }` — all the admin's
 * inline reassign sends — erased the note as a side effect, and the "nothing to update"
 * refinement below could never fire. An explicit null still clears the note.
 *
 * A change of `assignedTo` is carried out as a move (see `followUpMove.service.ts`), so it
 * gets the move's guarantees: pending only, the same-day duplicate rule, one transaction.
 */
export const editFollowUpSchema = z
  .object({
    note: optionalLine(1000).optional(),
    assignedTo: z.coerce.number().int().positive().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update.',
  });

export type EditFollowUpInput = z.infer<typeof editFollowUpSchema>;

/* -------------------------------------------------------------------------- */
/* Moving one follow-up                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A move's new time: any ISO instant, cut to the whole minute.
 *
 * NOT `futureDueAtField`. The future and two-year limits apply only when the time
 * actually changes, which only the service can tell: a dialog that sends the current
 * time back unchanged — already past, for an overdue follow-up that is being handed to
 * someone else — must not be refused over a time it is not changing.
 */
const moveDueAtField = z
  .string({ invalid_type_error: 'Choose a date and time.' })
  .datetime({ offset: true, message: 'Expected an ISO-8601 timestamp.' })
  .transform((value) => toWholeMinute(new Date(value)));

/**
 * What the admin's screen showed as current when they opened the move.
 *
 * Optimistic concurrency: two supervisors re-planning the same afternoon must not
 * silently overwrite each other. If the follow-up no longer looks like this, the move is
 * refused with 409 `follow_up_changed` and the current values, instead of applying a
 * change the second person made against a stale picture.
 */
const expectedFollowUpSchema = z.object({
  dueAt: z.string().datetime({ offset: true, message: 'Expected an ISO-8601 timestamp.' }),
  assignedTo: z.coerce.number().int().positive().nullable(),
  leadId: z.coerce.number().int().positive(),
});

/**
 * Move a pending follow-up: any of a new time, a new lead and a new employee.
 *
 * Each field left out stays as it is, and at least one must be sent. `transferLead` also
 * makes the employee the owner of the lead — without it, an employee can hold a follow-up
 * on a lead their app cannot open.
 */
export const moveFollowUpSchema = z
  .object({
    dueAt: moveDueAtField.optional(),
    leadId: z.coerce.number().int().positive().optional(),
    assignedTo: z.coerce.number().int().positive().optional(),
    /** A new note for the follow-up; absent or empty keeps the current one. */
    note: optionalLine(1000),
    /** Why, for the audit log and the move history. */
    reason: optionalLine(255),
    transferLead: z.boolean().default(false),
    expected: expectedFollowUpSchema.optional(),
  })
  .refine(
    (value) => value.dueAt !== undefined || value.leadId !== undefined || value.assignedTo !== undefined,
    { message: 'Choose a new date and time, a different lead or a different employee.' },
  );

export type MoveFollowUpInput = z.infer<typeof moveFollowUpSchema>;

/* -------------------------------------------------------------------------- */
/* Handing over many                                                           */
/* -------------------------------------------------------------------------- */

const handoverDueAtField = futureDueAtField.transform(toWholeMinute);

/**
 * When handed-over follow-ups fall due.
 *
 *   keep        every follow-up keeps its own time — the long-standing behaviour
 *   overdue_to  only the overdue ones are re-dated to `dueAt`, so a leaver's backlog does
 *               not land on their cover as a wall of red
 *   all_to      every one is re-dated to `dueAt`
 */
export const handoverScheduleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep') }),
  z.object({ mode: z.literal('overdue_to'), dueAt: handoverDueAtField }),
  z.object({ mode: z.literal('all_to'), dueAt: handoverDueAtField }),
]);

export type HandoverSchedule = z.infer<typeof handoverScheduleSchema>;

/**
 * The most follow-ups a handover may select by id, and may move in one go when none are
 * named. Bounded because the whole handover is one transaction holding row locks during
 * working hours; above the cap the admin moves them in batches, which the screen's
 * paged list already works in.
 */
export const HANDOVER_SELECTION_MAX = 500;
export const HANDOVER_BATCH_MAX = 1000;

/**
 * Move pending follow-ups from one employee to another (`POST /employees/:id/handover-follow-ups`).
 *
 * The original body `{ toEmployeeId }` is still valid and still means what it did: every
 * pending follow-up, times kept.
 */
export const handoverFollowUpsSchema = z.object({
  toEmployeeId: z.coerce.number().int().positive(),
  /** Omitted: every pending follow-up the employee holds. */
  followUpIds: z
    .array(z.coerce.number().int().positive())
    .min(1, 'Choose at least one follow-up to move.')
    .max(HANDOVER_SELECTION_MAX, `Move at most ${HANDOVER_SELECTION_MAX} follow-ups at a time.`)
    .optional(),
  schedule: handoverScheduleSchema.default({ mode: 'keep' }),
  /** Also transfer the leads, behind the moved follow-ups, that the employee owns. */
  transferLeads: z.boolean().default(false),
  reason: optionalLine(255),
});

export type HandoverFollowUpsInput = z.infer<typeof handoverFollowUpsSchema>;

/** The same handover as part of a deactivation, which always moves everything. */
export const deactivationHandoverSchema = handoverFollowUpsSchema.omit({ followUpIds: true });

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

export const followUpListQuerySchema = paginationSchema.extend({
  /**
   * `today`, `upcoming` and `overdue` are date windows over `state = 'pending'`, not
   * stored states. Keeping them as a scope puts that arithmetic in one place instead of
   * in every screen that lists follow-ups. `today` and `completed_today` are the IST day.
   */
  scope: z.enum(FOLLOW_UP_SCOPES).default('today'),
  assignedTo: z.coerce.number().int().positive().optional(),
  leadId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(120).optional(),
  /** Inclusive IST calendar days, on the due time. */
  from: z.string().date('Expected YYYY-MM-DD.').optional(),
  to: z.string().date('Expected YYYY-MM-DD.').optional(),
});

export type FollowUpListQuery = z.infer<typeof followUpListQuerySchema>;
