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
 * A follow-up must be in the future — with a minute of slack.
 *
 * The slack matters: a phone that has been offline sends a follow-up it created ten
 * seconds ago, and clock skew between a handset and the server is routinely a few
 * seconds. Rejecting those would fail the sync for a follow-up the telecaller correctly
 * booked for later today.
 */
const dueAtField = z
  .string({ required_error: 'Choose when to follow up.' })
  .datetime({ offset: true, message: 'Expected an ISO-8601 timestamp.' })
  .transform((value) => new Date(value))
  .refine((value) => value.getTime() > Date.now() - 60_000, {
    message: 'Choose a time in the future.',
  })
  .refine((value) => value.getTime() < Date.now() + 2 * 365 * 86_400_000, {
    // A follow-up two years out is a typo in the year, not a plan.
    message: 'That date is too far in the future.',
  });

export const createFollowUpSchema = z.object({
  leadId: z.coerce.number().int().positive(),
  dueAt: dueAtField,
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
  dueAt: dueAtField,
  note: optionalLine(1000),
});

export const completeFollowUpSchema = z.object({
  outcomeNote: optionalLine(1000),
  clientUuid: clientUuidField,
});

export const editFollowUpSchema = z
  .object({
    note: optionalLine(1000),
    assignedTo: z.coerce.number().int().positive().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update.',
  });

export const followUpListQuerySchema = paginationSchema.extend({
  /**
   * `today`, `upcoming` and `overdue` are date windows over `state = 'pending'`, not
   * stored states. Keeping them as a scope puts that arithmetic in one place instead of
   * in every screen that lists follow-ups.
   */
  scope: z.enum(FOLLOW_UP_SCOPES).default('today'),
  assignedTo: z.coerce.number().int().positive().optional(),
  leadId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(120).optional(),
  from: z.string().date('Expected YYYY-MM-DD.').optional(),
  to: z.string().date('Expected YYYY-MM-DD.').optional(),
});

export type FollowUpListQuery = z.infer<typeof followUpListQuerySchema>;
