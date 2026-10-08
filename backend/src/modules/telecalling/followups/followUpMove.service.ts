import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../../../db/pool';
import {
  badRequest,
  conflict,
  notFound,
  validationFailed,
  type HttpError,
} from '../../../utils/httpError';
import { actorLabel, type Actor } from '../actor';
import { recordActivityTx, recordAudit } from '../activity/activity.repository';
import { companyDate, formatCompanyDateTime } from '../companyTime';
import {
  lockAssignableEmployeeTx,
  lockEmployeesForUpdateTx,
  type LockedEmployee,
} from '../employees/employee.repository';
import {
  lockLeadsForUpdateTx,
  refreshLeadCachesTx,
  type LockedLead,
} from '../leads/lead.repository';
import { reassignLeadInTx } from '../leads/lead.service';
import {
  markFollowUpNotificationsReadTx,
  queueNotification,
  retargetFollowUpNotificationsTx,
} from '../notifications/notification.repository';
import {
  applyFollowUpMoveTx,
  countPendingFollowUpsLockedTx,
  countPendingOnLead,
  findFollowUp,
  findFollowUpTx,
  findSameDayDuplicateTx,
  followUpHoldersTx,
  insertFollowUpMovesTx,
  listHandoverCandidatesTx,
  lockFollowUpForUpdateTx,
  lockFollowUpsForUpdateTx,
  updateFollowUpNote,
  type FollowUpMoveHistory,
  type FollowUpRecord,
  type HandoverCandidate,
} from './followUp.repository';
import {
  FOLLOW_UP_HORIZON_MS,
  FOLLOW_UP_PAST_SLACK_MS,
  HANDOVER_BATCH_MAX,
  toWholeMinute,
  type EditFollowUpInput,
  type HandoverFollowUpsInput,
  type HandoverSchedule,
  type MoveFollowUpInput,
} from './followUp.schema';

/**
 * Moving follow-ups: one at a time — a new time, a new lead, a new employee, or any mix —
 * and in bulk, when an employee is leaving or away (spec: Admin Module 8; requirements 8
 * and 9).
 *
 * In its own module rather than `followUp.service.ts` because a move can also transfer
 * the lead, which is `lead.service.ts`'s job, and that module already imports the
 * follow-up service to book follow-ups. Moves living here keep the import graph a line
 * rather than a loop.
 *
 * Every write follows the lock protocol described on `resolveFollowUpAssigneeTx`:
 * employee rows, then lead rows, then follow-up rows, each in ascending id order. The
 * employee who will hold a moved follow-up is always locked first, which is what keeps a
 * move and a deactivation of that employee from interleaving into a pending follow-up
 * held by a deactivated account.
 *
 * Who did it is recorded three ways, each for its own reader: a timeline line on every
 * lead involved (in the transaction), a `follow_up_moves` row per follow-up (in the
 * transaction — the history that cannot disagree with the data), and an audit entry
 * (after commit, best-effort, like every audit entry).
 */

const CHANGED_MESSAGE = 'This follow-up was changed by someone else. Review it and try again.';
const NOT_PENDING_MESSAGE = 'Only a pending follow-up can be moved.';

/* -------------------------------------------------------------------------- */
/* One follow-up                                                               */
/* -------------------------------------------------------------------------- */

/** What a move changed, current to new, for the screen that confirms it. */
export type MoveFollowUpChanges = {
  dueAt?: { from: string; to: string };
  assignedTo?: { from: number | null; fromName: string | null; to: number; toName: string };
  leadId?: {
    from: number;
    fromReference: string;
    fromName: string;
    to: number;
    toReference: string;
    toName: string;
  };
};

export type MoveFollowUpResult = {
  followUp: FollowUpRecord;
  /** False when the follow-up already matched the request, so a retried move is a no-op. */
  changed: boolean;
  changes: MoveFollowUpChanges;
  leadTransferred: boolean;
  /**
   * Pending follow-ups left on the lead the follow-up was on before — zero means that
   * customer now has nothing booked, which the screen may want to point out.
   */
  sourceLeadPendingFollowUps: number;
};

/**
 * How a move was asked for, which decides how an employee who cannot take it is refused:
 * the move dialog shows a field error (422 on `assignedTo`), while the inline reassign
 * (`PATCH /follow-ups/:id`) keeps the 400 its clients already handle.
 */
type MoveMode = 'move' | 'reassign';

type MoveRequest = {
  dueAt?: Date;
  leadId?: number;
  assignedTo?: number;
  /** Absent keeps the note; present replaces it (null clears). */
  note?: { value: string | null };
  reason: string | null;
  transferLead: boolean;
  expected?: { dueAt: string; assignedTo: number | null; leadId: number };
};

/**
 * Moves a pending follow-up to a new time, lead or employee (`POST /follow-ups/:id/move`).
 *
 * One transaction: the new holder is share-locked and must be able to take the work, both
 * leads and then the follow-up are locked and re-checked against what the admin saw, the
 * same-day duplicate rule is applied, and the timeline, caches, notifications and move
 * history change with the row.
 */
export async function moveFollowUp(
  id: number,
  input: MoveFollowUpInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<MoveFollowUpResult> {
  return performMove(
    id,
    {
      dueAt: input.dueAt,
      leadId: input.leadId,
      assignedTo: input.assignedTo,
      // The move contract: no note (or an empty one) keeps the current note.
      note: input.note !== null ? { value: input.note } : undefined,
      reason: input.reason,
      transferLead: input.transferLead,
      expected: input.expected,
    },
    actor,
    ipAddress,
    'move',
  );
}

/**
 * Edits a follow-up's note, or reassigns it. Supervisor and above (spec: Admin Module 8).
 *
 * Deliberately not available to a telecaller even for their own follow-up: handing work
 * to a colleague is a scheduling decision, and the person who has to make the call is
 * not the person who should decide it is someone else's problem.
 *
 * A new `assignedTo` is carried out as a move, so the inline reassign gets the move's
 * guarantees — pending only (409 `follow_up_not_pending`; completed and cancelled
 * follow-ups used to be reassigned silently), the same-day duplicate rule (409
 * `duplicate_follow_up`), one transaction, a `follow_up_reassigned` timeline line rather
 * than a misleading "rescheduled", and an audit entry. A note on its own is edited in
 * place, whatever the follow-up's state.
 */
export async function editFollowUp(
  id: number,
  fields: EditFollowUpInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<FollowUpRecord> {
  const existing = await findFollowUp(id, null);
  if (!existing) throw notFound('Follow-up not found.');

  if (fields.assignedTo !== undefined && fields.assignedTo !== existing.assignedTo) {
    const result = await performMove(
      id,
      {
        assignedTo: fields.assignedTo,
        note: fields.note === undefined ? undefined : { value: fields.note },
        reason: null,
        transferLead: false,
      },
      actor,
      ipAddress,
      'reassign',
    );
    return result.followUp;
  }

  // Reassigned to the employee who already holds it, and no note: nothing to do.
  if (fields.note === undefined) return existing;

  const updated = await updateFollowUpNote(id, fields.note);
  if (!updated) throw notFound('Follow-up not found.');

  const after = await findFollowUp(id, null);
  if (!after) throw notFound('Follow-up not found.');
  return after;
}

async function performMove(
  id: number,
  request: MoveRequest,
  actor: Actor,
  ipAddress: string | null,
  mode: MoveMode,
): Promise<MoveFollowUpResult> {
  const current = await findFollowUp(id, null);
  if (!current) throw notFound('Follow-up not found.');

  const currentDue = new Date(current.dueAt);
  const target = {
    leadId: request.leadId ?? current.leadId,
    assignedTo: request.assignedTo ?? current.assignedTo,
    /*
     * The minute already set counts as unchanged: a follow-up booked from a phone at
     * 10:00:37 reads "10:00" on every screen, and sending "10:00" back must not count as
     * re-dating it (nor refuse it as past, for an overdue one being handed on).
     */
    dueAt:
      request.dueAt !== undefined && request.dueAt.getTime() !== toWholeMinute(currentDue).getTime()
        ? request.dueAt
        : currentDue,
  };

  const dueChanged = target.dueAt.getTime() !== currentDue.getTime();
  const leadChanged = target.leadId !== current.leadId;
  const assigneeChanged = target.assignedTo !== current.assignedTo;

  /*
   * Already where it was asked to be. Checked FIRST, before the stale-view check, so a
   * move whose response was lost can be retried and answer "done" rather than "changed
   * by someone else" — the someone being the first attempt.
   */
  if (!dueChanged && !leadChanged && !assigneeChanged) {
    return {
      followUp: current,
      changed: false,
      changes: {},
      leadTransferred: false,
      sourceLeadPendingFollowUps: await countPendingOnLead(current.leadId),
    };
  }

  if (request.expected && !matchesExpected(current, request.expected)) {
    throw conflict(CHANGED_MESSAGE, 'follow_up_changed', { current });
  }

  if (current.state !== 'pending') throw conflict(NOT_PENDING_MESSAGE, 'follow_up_not_pending');

  if (dueChanged) assertWorkableTime(target.dueAt);

  const commit = await withTransaction(async (connection) => {
    /*
     * 1. The employee who will hold it — share-locked, the protocol's first step — even
     *    when unchanged: the follow-up stays pending on them, so a deactivation running
     *    now must be ordered against this move. An unassigned follow-up has nobody to lock.
     */
    let assignee: LockedEmployee | null = null;
    if (target.assignedTo !== null) {
      assignee = await lockAssignableEmployeeTx(connection, target.assignedTo);
      if (!assignee || !assignee.assignable) {
        throw unworkableAssignee(mode, assignee, !assigneeChanged);
      }
    }

    // 2. Both leads, in ascending id order. The lead it is moving away from may be
    //    archived; the one it is moving onto may not.
    const leads = await lockLeadsForUpdateTx(connection, [current.leadId, target.leadId]);
    const targetLead = leads.find((lead) => lead.id === target.leadId);
    if (!targetLead) {
      if (leadChanged) throw validationFailed({ leadId: 'That lead no longer exists.' });
      // The follow-up's own lead is gone, and its follow-ups went with it.
      throw notFound('Follow-up not found.');
    }
    if (leadChanged && targetLead.isArchived) {
      throw validationFailed({
        leadId: 'That lead is archived. Restore it before moving a follow-up onto it.',
      });
    }

    // 3. The follow-up itself, checked against what was read before any lock was held.
    const locked = await lockFollowUpForUpdateTx(connection, id);
    if (!locked) throw notFound('Follow-up not found.');
    if (locked.state !== 'pending') throw conflict(NOT_PENDING_MESSAGE, 'follow_up_not_pending');
    if (
      locked.leadId !== current.leadId ||
      locked.assignedTo !== current.assignedTo ||
      locked.dueAt.getTime() !== currentDue.getTime()
    ) {
      throw conflict(CHANGED_MESSAGE, 'follow_up_changed', {
        current: await findFollowUpTx(connection, id),
      });
    }

    const sourceLead = leads.find((lead) => lead.id === current.leadId);
    if (!sourceLead) throw notFound('Follow-up not found.');

    /*
     * 4. The same-day rule — only when the move changes the (lead, employee, IST day)
     *    combination. Re-timing a follow-up within its own day, or a move onto a day the
     *    employee already had with this customer before this follow-up existed, is not
     *    this move's doing to refuse.
     */
    const dayChanged = companyDate(target.dueAt) !== companyDate(currentDue);
    if (target.assignedTo !== null && (leadChanged || assigneeChanged || dayChanged)) {
      const duplicate = await findSameDayDuplicateTx(connection, {
        leadId: target.leadId,
        assignedTo: target.assignedTo,
        dueAt: target.dueAt,
        excludeId: id,
      });
      if (duplicate) {
        const holder = assignee?.name ?? 'That employee';
        throw conflict(
          `${holder} already has a follow-up with ${targetLead.customerName} on ${formatCompanyDateTime(duplicate.dueAt)}. Move that one instead, or choose another day.`,
          'duplicate_follow_up',
          {
            conflict: {
              id: duplicate.id,
              dueAt: duplicate.dueAt,
              assignedTo: duplicate.assignedTo,
              assignedToName: assignee?.name ?? null,
              leadId: duplicate.leadId,
            },
          },
        );
      }
    }

    // 5. The row.
    await applyFollowUpMoveTx(connection, id, {
      leadId: target.leadId,
      assignedTo: target.assignedTo,
      dueAt: target.dueAt,
      dueChanged,
      resetReminder: dueChanged || assigneeChanged,
      note: request.note,
    });

    /*
     * 6. The lead, when asked: an employee holding a follow-up on a lead they do not own
     *    can see the follow-up but cannot open the lead or log calls to it in the app.
     *    `reassignLeadInTx` moves every other pending follow-up on the lead as well —
     *    lead ownership carries its commitments, as it always has.
     */
    let leadTransferred = false;
    if (
      request.transferLead &&
      target.assignedTo !== null &&
      targetLead.assignedTo !== target.assignedTo
    ) {
      await reassignLeadInTx(connection, targetLead, target.assignedTo, request.reason, actor);
      leadTransferred = true;
    }

    // 7. Notifications follow the follow-up: they deep-link to the lead it is on now, and
    //    stop counting as unread work for someone who no longer holds it.
    if (leadChanged) await retargetFollowUpNotificationsTx(connection, id, target.leadId);
    if (assigneeChanged && current.assignedTo !== null) {
      await markFollowUpNotificationsReadTx(connection, id, current.assignedTo);
    }

    // 8. The timeline, on every lead involved.
    const fromName =
      current.assignedTo === null ? null : current.assignedToName ?? 'a former employee';
    const toName = target.assignedTo === null ? null : assignee?.name ?? null;
    const meta = {
      followUpId: id,
      from: {
        leadId: current.leadId,
        assignedTo: current.assignedTo,
        dueAt: currentDue.toISOString(),
      },
      to: {
        leadId: target.leadId,
        assignedTo: target.assignedTo,
        dueAt: target.dueAt.toISOString(),
      },
      reason: request.reason,
    };

    for (const entry of timelineEntries({
      actor,
      sourceLead,
      targetLead,
      fromName,
      toName,
      fromDue: currentDue,
      toDue: target.dueAt,
      wasUnassigned: current.assignedTo === null,
      dueChanged,
      assigneeChanged,
      leadChanged,
    })) {
      await recordActivityTx(connection, { ...entry, userId: actor.id, meta });
    }

    // 9. The cached next-follow-up time, on both leads, in ascending id order. A change
    //    of holder alone does not move it.
    if (dueChanged || leadChanged) {
      for (const leadId of [...new Set([current.leadId, target.leadId])].sort((a, b) => a - b)) {
        await refreshLeadCachesTx(connection, leadId);
      }
    }

    // 10. The move history.
    await insertFollowUpMovesTx(connection, [
      {
        followUpId: id,
        batchId: null,
        kind: 'move',
        fromLeadId: current.leadId,
        toLeadId: target.leadId,
        fromAssignedTo: current.assignedTo,
        toAssignedTo: target.assignedTo,
        fromDueAt: currentDue,
        toDueAt: target.dueAt,
        reason: request.reason,
        movedBy: actor.id,
        movedByLabel: actorLabel(actor),
      },
    ]);

    return {
      sourceLead,
      targetLead,
      assigneeName: toName,
      leadTransferred,
      sourceLeadPendingFollowUps: await countPendingOnLead(current.leadId, connection),
    };
  });

  const changes: MoveFollowUpChanges = {};
  if (dueChanged) {
    changes.dueAt = { from: currentDue.toISOString(), to: target.dueAt.toISOString() };
  }
  if (assigneeChanged && target.assignedTo !== null) {
    changes.assignedTo = {
      from: current.assignedTo,
      fromName: current.assignedToName,
      to: target.assignedTo,
      toName: commit.assigneeName ?? '',
    };
  }
  if (leadChanged) {
    changes.leadId = {
      from: current.leadId,
      fromReference: commit.sourceLead.reference,
      fromName: commit.sourceLead.customerName,
      to: target.leadId,
      toReference: commit.targetLead.reference,
      toName: commit.targetLead.customerName,
    };
  }

  const parts: string[] = [];
  if (dueChanged) parts.push(`to ${formatCompanyDateTime(target.dueAt)}`);
  if (assigneeChanged) parts.push(`to ${who(commit.assigneeName)}`);
  if (leadChanged) parts.push(`onto lead ${commit.targetLead.reference}`);

  await recordAudit({
    actor,
    action: 'follow_up_moved',
    entityType: 'follow_up',
    entityId: id,
    summary: `Moved a follow-up with ${commit.sourceLead.customerName} ${parts.join(', ')}`,
    meta: {
      from: {
        leadId: current.leadId,
        assignedTo: current.assignedTo,
        dueAt: currentDue.toISOString(),
      },
      to: {
        leadId: target.leadId,
        assignedTo: target.assignedTo,
        dueAt: target.dueAt.toISOString(),
      },
      reason: request.reason,
      transferLead: request.transferLead,
      leadTransferred: commit.leadTransferred,
      via: mode,
    },
    ipAddress,
  });

  // The person who now owes the call hears about it — unless they moved it themselves.
  if (target.assignedTo !== null && target.assignedTo !== actor.id) {
    await queueNotification({
      userId: target.assignedTo,
      kind: 'follow_up_due',
      title: assigneeChanged
        ? 'Follow-up assigned to you'
        : leadChanged
          ? 'Follow-up moved'
          : 'Follow-up rescheduled',
      body: `${commit.targetLead.customerName} — ${formatCompanyDateTime(target.dueAt)}`,
      leadId: target.leadId,
      followUpId: id,
    });
  }

  const followUp = await findFollowUp(id, null);
  if (!followUp) throw notFound('Follow-up not found.');

  return {
    followUp,
    changed: true,
    changes,
    leadTransferred: commit.leadTransferred,
    sourceLeadPendingFollowUps: commit.sourceLeadPendingFollowUps,
  };
}

function matchesExpected(
  current: FollowUpRecord,
  expected: NonNullable<MoveRequest['expected']>,
): boolean {
  return (
    Date.parse(expected.dueAt) === Date.parse(current.dueAt) &&
    expected.assignedTo === current.assignedTo &&
    expected.leadId === current.leadId
  );
}

/** The limits `futureDueAtField` applies at booking, applied to a changed time. */
function assertWorkableTime(dueAt: Date): void {
  const now = Date.now();
  if (dueAt.getTime() <= now - FOLLOW_UP_PAST_SLACK_MS) {
    throw validationFailed({ dueAt: 'Choose a time in the future.' });
  }
  if (dueAt.getTime() >= now + FOLLOW_UP_HORIZON_MS) {
    throw validationFailed({ dueAt: 'That date is too far in the future.' });
  }
}

function unworkableAssignee(
  mode: MoveMode,
  employee: LockedEmployee | null,
  kept: boolean,
): HttpError {
  if (mode === 'reassign') {
    return employee
      ? badRequest('That employee is deactivated.')
      : badRequest('The chosen employee does not exist.');
  }

  if (!employee) return validationFailed({ assignedTo: 'That employee no longer exists.' });

  const why =
    employee.approvalStatus === 'approved'
      ? `${employee.name} is deactivated.`
      : `${employee.name}'s registration has not been approved.`;

  // Kept: an older follow-up still held by someone who has left. Moving its time alone
  // would leave it with nobody able to make the call, so the move has to name someone.
  return validationFailed({
    assignedTo: kept ? `${why} Choose who should make this call.` : `${why} Choose someone else.`,
  });
}

function who(name: string | null): string {
  return name ?? 'no one';
}

/**
 * The timeline lines for one move.
 *
 * The type says what kind of change it was — `follow_up_rescheduled` for a new time,
 * `follow_up_reassigned` for a new holder, `follow_up_moved` for several at once or a new
 * lead — and a move between leads is told on both, so neither customer's story loses the
 * follow-up without a trace.
 */
function timelineEntries(move: {
  actor: Actor;
  sourceLead: LockedLead;
  targetLead: LockedLead;
  fromName: string | null;
  toName: string | null;
  fromDue: Date;
  toDue: Date;
  wasUnassigned: boolean;
  dueChanged: boolean;
  assigneeChanged: boolean;
  leadChanged: boolean;
}): {
  leadId: number;
  type: 'follow_up_moved' | 'follow_up_rescheduled' | 'follow_up_reassigned';
  summary: string;
}[] {
  const name = move.actor.name;
  const from = formatCompanyDateTime(move.fromDue);
  const to = formatCompanyDateTime(move.toDue);

  if (move.leadChanged) {
    return [
      {
        leadId: move.sourceLead.id,
        type: 'follow_up_moved',
        summary: `${name} moved a follow-up to ${move.targetLead.customerName} (${move.targetLead.reference})`,
      },
      {
        leadId: move.targetLead.id,
        type: 'follow_up_moved',
        summary: `${name} moved a follow-up here from ${move.sourceLead.customerName} (${move.sourceLead.reference}), due ${to} with ${who(move.toName)}`,
      },
    ];
  }

  if (move.dueChanged && move.assigneeChanged) {
    return [
      {
        leadId: move.targetLead.id,
        type: 'follow_up_moved',
        summary: `${name} moved a follow-up from ${from} with ${who(move.fromName)} to ${to} with ${who(move.toName)}`,
      },
    ];
  }

  if (move.dueChanged) {
    return [
      {
        leadId: move.targetLead.id,
        type: 'follow_up_rescheduled',
        // Worded as the reschedule button's line, so the two read alike on a timeline.
        summary: `${name} moved a follow-up from ${from} to ${to}`,
      },
    ];
  }

  return [
    {
      leadId: move.targetLead.id,
      type: 'follow_up_reassigned',
      summary: move.wasUnassigned
        ? `${name} assigned a follow-up to ${who(move.toName)}`
        : `${name} reassigned a follow-up from ${who(move.fromName)} to ${who(move.toName)}`,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Handing over many                                                           */
/* -------------------------------------------------------------------------- */

export type HandoverSkipReason =
  | 'duplicate'
  | 'not_pending'
  | 'not_assigned_to_employee'
  | 'not_found';

/** A follow-up the handover left where it was, and why. */
export type HandoverSkippedRow = {
  followUpId: number;
  leadId: number | null;
  leadName: string | null;
  dueAt: string | null;
  reason: HandoverSkipReason;
  /** For `duplicate`: the receiving employee's own follow-up it would have doubled. */
  conflictWithId?: number;
};

export type HandoverResult = {
  moved: number;
  /** Shared by every row this handover wrote to the move history. */
  batchId: string;
  skipped: HandoverSkippedRow[];
  /** Still pending on the employee the follow-ups were moved away from. */
  remainingPending: number;
  leadsTransferred: number;
};

/** What `handoverFollowUpsTx` did, with what the caller needs once it has committed. */
export type HandoverOutcome = HandoverResult & {
  from: { id: number; name: string; employeeCode: string };
  to: { id: number; name: string; employeeCode: string };
  movedIds: number[];
  /** When exactly one follow-up moved, where it is — so the notification can link to it. */
  singleMove: { followUpId: number; leadId: number } | null;
};

/** The parts of a handover request the audit entry records. */
export type HandoverRecordInput = Pick<
  HandoverFollowUpsInput,
  'schedule' | 'transferLeads' | 'reason'
>;

/**
 * Moves pending follow-ups from one employee to another
 * (`POST /employees/:id/handover-follow-ups`).
 *
 * The action an admin needs when someone resigns or goes on leave, and the reason
 * `follow_ups.assigned_to` is separate from `leads.assigned_to`: the commitments can be
 * covered for a fortnight without permanently transferring the leads.
 */
export async function handoverFollowUps(
  fromId: number,
  input: HandoverFollowUpsInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<HandoverResult> {
  if (fromId === input.toEmployeeId) throw badRequest('Choose a different employee.');

  const batchId = randomUUID();
  const outcome = await withTransaction((connection) =>
    handoverFollowUpsTx(connection, fromId, input, actor, { batchId, kind: 'handover' }),
  );

  await recordHandover(outcome, input, actor, ipAddress, 'handover');
  return handoverResult(outcome);
}

/**
 * The handover itself, inside the caller's transaction — its own, or the deactivation's,
 * which must roll the whole move back if anything would still be left behind.
 *
 * 1. Both employees exclusively, in ascending id order. The one handing over may already
 *    be deactivated — that is how follow-ups stranded on a leaver are cleared — but the
 *    one receiving must be able to take work.
 * 2. The follow-ups to move: the named ones, or every pending one the employee holds (at
 *    most HANDOVER_BATCH_MAX in one go; the whole thing is one transaction holding row
 *    locks during working hours).
 * 3. Their leads, then the rows, and re-check each against what was read.
 * 4. Each row, soonest due first: re-dated if the schedule says so, checked against the
 *    same-day duplicate rule for the receiving employee — rows moved earlier in this loop
 *    count, so two of the leaver's follow-ups for one customer on one day cannot both
 *    land on their cover — then moved, with a timeline line and a history row of its own.
 *    The original bulk UPDATE deliberately wrote no timeline lines; a line per follow-up
 *    is what tells the new holder why the call is theirs, on the lead they will open.
 * 5. The leads behind the moved rows, if asked and if the leaver owns them.
 */
export async function handoverFollowUpsTx(
  connection: PoolConnection,
  fromId: number,
  input: HandoverFollowUpsInput,
  actor: Actor,
  options: { batchId: string; kind: 'handover' | 'deactivation' },
): Promise<HandoverOutcome> {
  if (fromId === input.toEmployeeId) throw badRequest('Choose a different employee.');

  // 1. The employees.
  const employees = await lockEmployeesForUpdateTx(connection, [fromId, input.toEmployeeId]);
  const from = employees.find((employee) => employee.id === fromId);
  const to = employees.find((employee) => employee.id === input.toEmployeeId);
  if (!from) throw notFound('Employee not found.');
  if (!to) throw badRequest('The chosen employee does not exist.');
  if (!to.assignable) throw badRequest('That employee is deactivated.');

  // 2. The candidates.
  const selection = input.followUpIds ?? null;
  const candidates = await listHandoverCandidatesTx(
    connection,
    fromId,
    selection,
    HANDOVER_BATCH_MAX + 1,
  );
  if (selection === null && candidates.length > HANDOVER_BATCH_MAX) {
    throw badRequest(
      `${from.name} has more than ${HANDOVER_BATCH_MAX.toLocaleString('en-IN')} pending follow-ups, too many to move in one go. Select them in batches from the list instead.`,
    );
  }

  const skipped: HandoverSkippedRow[] = [];
  if (selection !== null) {
    const found = new Set(candidates.map((candidate) => candidate.id));
    for (const id of new Set(selection)) {
      if (!found.has(id)) {
        skipped.push({ followUpId: id, leadId: null, leadName: null, dueAt: null, reason: 'not_found' });
      }
    }
  }

  const eligible: HandoverCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.state !== 'pending') skipped.push(skippedRow(candidate, 'not_pending'));
    else if (candidate.assignedTo !== fromId) {
      skipped.push(skippedRow(candidate, 'not_assigned_to_employee'));
    } else eligible.push(candidate);
  }

  // 3. Their leads, then the rows themselves.
  const leads = await lockLeadsForUpdateTx(
    connection,
    eligible.map((candidate) => candidate.leadId),
  );
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const lockedRows = await lockFollowUpsForUpdateTx(
    connection,
    eligible.map((candidate) => candidate.id),
  );
  const lockedById = new Map(lockedRows.map((row) => [row.id, row]));

  // 4. Each row, soonest due first (the candidates' order).
  const now = Date.now();
  const history: FollowUpMoveHistory[] = [];
  const movedIds: number[] = [];
  const movedLeadIds = new Set<number>();
  const redatedLeadIds = new Set<number>();
  let singleMove: { followUpId: number; leadId: number } | null = null;

  const historyRow = (candidate: HandoverCandidate, toDueAt: Date): FollowUpMoveHistory => ({
    followUpId: candidate.id,
    batchId: options.batchId,
    kind: options.kind,
    fromLeadId: candidate.leadId,
    toLeadId: candidate.leadId,
    fromAssignedTo: fromId,
    toAssignedTo: to.id,
    fromDueAt: candidate.dueAt,
    toDueAt,
    reason: input.reason,
    movedBy: actor.id,
    movedByLabel: actorLabel(actor),
  });

  for (const candidate of eligible) {
    const row = lockedById.get(candidate.id);

    // Gone with its lead, or changed by someone else between the read and the lock.
    if (!row) {
      skipped.push(skippedRow(candidate, 'not_found'));
      continue;
    }
    if (row.state !== 'pending') {
      skipped.push(skippedRow(candidate, 'not_pending'));
      continue;
    }
    if (row.assignedTo !== fromId) {
      skipped.push(skippedRow(candidate, 'not_assigned_to_employee'));
      continue;
    }
    /*
     * Its lead changed under us. Not reachable by the protocol — a move that keeps this
     * holder share-locks them, which our exclusive lock forbids — but its new lead is not
     * locked here, so it is left alone rather than written against the wrong lead.
     */
    if (row.leadId !== candidate.leadId || !leadById.has(row.leadId)) {
      skipped.push(skippedRow(candidate, 'not_found'));
      continue;
    }

    const newDue = rescheduledDue(input.schedule, row.dueAt, now);
    const dueChanged = newDue.getTime() !== row.dueAt.getTime();

    const duplicate = await findSameDayDuplicateTx(connection, {
      leadId: row.leadId,
      assignedTo: to.id,
      dueAt: newDue,
      excludeId: row.id,
    });
    if (duplicate) {
      skipped.push(skippedRow(candidate, 'duplicate', duplicate.id));
      continue;
    }

    await applyFollowUpMoveTx(connection, row.id, {
      leadId: row.leadId,
      assignedTo: to.id,
      dueAt: newDue,
      dueChanged,
      resetReminder: true,
    });
    await markFollowUpNotificationsReadTx(connection, row.id, fromId);

    await recordActivityTx(connection, {
      leadId: row.leadId,
      userId: actor.id,
      type: dueChanged ? 'follow_up_moved' : 'follow_up_reassigned',
      summary: `${actor.name} handed this follow-up from ${from.name} to ${to.name}${
        dueChanged ? `, moved to ${formatCompanyDateTime(newDue)}` : ''
      }`,
      meta: {
        followUpId: row.id,
        batchId: options.batchId,
        kind: options.kind,
        from: { assignedTo: fromId, dueAt: row.dueAt.toISOString() },
        to: { assignedTo: to.id, dueAt: newDue.toISOString() },
        reason: input.reason,
      },
    });

    history.push(historyRow(candidate, newDue));
    movedIds.push(row.id);
    movedLeadIds.add(row.leadId);
    if (dueChanged) redatedLeadIds.add(row.leadId);
    singleMove = { followUpId: row.id, leadId: row.leadId };
  }

  // 5. The leads.
  let leadsTransferred = 0;
  const transferredLeadIds = new Set<number>();
  if (input.transferLeads) {
    for (const leadId of [...movedLeadIds].sort((a, b) => a - b)) {
      const lead = leadById.get(leadId);
      if (!lead || lead.assignedTo !== fromId) continue;

      await reassignLeadInTx(
        connection,
        { ...lead, assignedToName: from.name },
        to.id,
        input.reason,
        actor,
      );
      transferredLeadIds.add(leadId);
      leadsTransferred += 1;
    }
  }

  /*
   * A transferred lead takes every pending follow-up on it along — lead ownership carries
   * its commitments — including one this handover skipped as a same-day duplicate. That
   * row is no longer left behind, so it is reported as moved, with a history row, rather
   * than offered back to the admin to deal with.
   */
  if (transferredLeadIds.size > 0) {
    const carried = skipped.filter(
      (row) => row.reason === 'duplicate' && row.leadId !== null && transferredLeadIds.has(row.leadId),
    );
    const holders = await followUpHoldersTx(
      connection,
      carried.map((row) => row.followUpId),
    );
    const candidateById = new Map(eligible.map((candidate) => [candidate.id, candidate]));

    for (const row of carried) {
      const candidate = candidateById.get(row.followUpId);
      if (!candidate || holders.get(row.followUpId) !== to.id) continue;

      skipped.splice(skipped.indexOf(row), 1);
      await markFollowUpNotificationsReadTx(connection, row.followUpId, fromId);
      history.push(historyRow(candidate, candidate.dueAt));
      movedIds.push(row.followUpId);
    }
  }

  for (const leadId of [...redatedLeadIds].sort((a, b) => a - b)) {
    await refreshLeadCachesTx(connection, leadId);
  }

  if (history.length > 0) await insertFollowUpMovesTx(connection, history);

  return {
    moved: movedIds.length,
    batchId: options.batchId,
    skipped,
    remainingPending: await countPendingFollowUpsLockedTx(connection, fromId),
    leadsTransferred,
    from: { id: from.id, name: from.name, employeeCode: from.employeeCode },
    to: { id: to.id, name: to.name, employeeCode: to.employeeCode },
    movedIds,
    singleMove: movedIds.length === 1 ? singleMove : null,
  };
}

/**
 * After a handover has committed: the audit entry, now carrying which follow-ups moved
 * and which were left (the original recorded only a count, so what a handover moved was
 * lost), and ONE notification to the receiving employee — not one per follow-up.
 */
export async function recordHandover(
  outcome: HandoverOutcome,
  input: HandoverRecordInput,
  actor: Actor,
  ipAddress: string | null,
  kind: 'handover' | 'deactivation',
): Promise<void> {
  await recordAudit({
    actor,
    action: 'follow_ups_handed_over',
    entityType: 'employee',
    entityId: outcome.from.id,
    summary: `Moved ${outcome.moved} pending follow-up(s) from ${outcome.from.name} to ${outcome.to.name}`,
    meta: {
      from: outcome.from.id,
      to: outcome.to.id,
      moved: outcome.moved,
      followUpIds: outcome.movedIds,
      skipped: outcome.skipped,
      schedule: describeSchedule(input.schedule),
      transferLeads: input.transferLeads,
      leadsTransferred: outcome.leadsTransferred,
      remainingPending: outcome.remainingPending,
      batchId: outcome.batchId,
      reason: input.reason,
      kind,
    },
    ipAddress,
  });

  if (outcome.moved > 0 && outcome.to.id !== actor.id) {
    await queueNotification({
      userId: outcome.to.id,
      kind: 'follow_up_due',
      title:
        outcome.moved === 1
          ? '1 follow-up assigned to you'
          : `${outcome.moved} follow-ups assigned to you`,
      body: `Previously with ${outcome.from.name}`,
      leadId: outcome.singleMove?.leadId ?? null,
      followUpId: outcome.singleMove?.followUpId ?? null,
    });
  }
}

export function handoverResult(outcome: HandoverOutcome): HandoverResult {
  return {
    moved: outcome.moved,
    batchId: outcome.batchId,
    skipped: outcome.skipped,
    remainingPending: outcome.remainingPending,
    leadsTransferred: outcome.leadsTransferred,
  };
}

function skippedRow(
  candidate: HandoverCandidate,
  reason: HandoverSkipReason,
  conflictWithId?: number,
): HandoverSkippedRow {
  return {
    followUpId: candidate.id,
    leadId: candidate.leadId,
    leadName: candidate.leadName,
    dueAt: candidate.dueAt.toISOString(),
    reason,
    ...(conflictWithId !== undefined ? { conflictWithId } : {}),
  };
}

/** When a handed-over follow-up now falls due, under the chosen schedule. */
function rescheduledDue(schedule: HandoverSchedule, dueAt: Date, now: number): Date {
  switch (schedule.mode) {
    case 'keep':
      return dueAt;
    case 'overdue_to':
      return dueAt.getTime() < now ? schedule.dueAt : dueAt;
    case 'all_to':
      return schedule.dueAt;
  }
}

function describeSchedule(schedule: HandoverSchedule): { mode: string; dueAt?: string } {
  return schedule.mode === 'keep'
    ? { mode: 'keep' }
    : { mode: schedule.mode, dueAt: schedule.dueAt.toISOString() };
}
