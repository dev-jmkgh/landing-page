import type { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../../../db/pool';
import { badRequest, notFound } from '../../../utils/httpError';
import { canActOnOwner, hasRole, ownershipScope, type Actor } from '../actor';
import { recordActivityTx } from '../activity/activity.repository';
import { formatCompanyDateTime } from '../companyTime';
import { lockAssignableEmployeeTx } from '../employees/employee.repository';
import {
  findLeadOwner,
  lockLeadsForUpdateTx,
  refreshLeadCachesTx,
} from '../leads/lead.repository';
import { queueNotification } from '../notifications/notification.repository';
import {
  cancelFollowUpTx,
  completeFollowUpTx,
  findFollowUp,
  findFollowUpByClientUuid,
  insertFollowUpTx,
  rescheduleFollowUpTx,
  type FollowUpRecord,
} from './followUp.repository';
import type { CreateFollowUpInput } from './followUp.schema';

/**
 * Follow-up business rules.
 *
 * Every write refreshes `leads.next_follow_up_at` in the same transaction. That column
 * is what both clients sort their lead lists by, and a stale value means the app shows a
 * telecaller the wrong next call — which is the one thing this module exists to get
 * right.
 */

/* -------------------------------------------------------------------------- */
/* Who owes the call — and the lock protocol behind it                         */
/* -------------------------------------------------------------------------- */

/**
 * Decides who a new pending follow-up is assigned to, INSIDE the writer's transaction.
 *
 * THE INVARIANT: no pending follow-up is ever assigned to someone who cannot work it.
 * Deactivating an employee is refused while they hold pending follow-ups, and that
 * refusal is only worth anything if nothing can slip a new one onto them while the
 * deactivation runs. The schema cannot enforce it — the migration runner splits on `;`,
 * so there are no triggers — so it is a lock protocol in this layer:
 *
 *   - Lock order, for every writer: employee rows (ascending id), then lead rows
 *     (ascending id), then follow-up rows. Two transactions that take locks in the same
 *     order cannot each hold what the other is waiting for.
 *   - Deactivation takes the employee row FOR UPDATE, counts their pending follow-ups
 *     under a share lock, and flips `is_active` — one transaction.
 *   - Every writer that assigns a pending follow-up calls this, which re-reads the
 *     assignee under LOCK IN SHARE MODE (`lockAssignableEmployeeTx`) in ITS transaction.
 *
 * So either the writer commits first and the deactivation's count sees the new row and
 * refuses, or the deactivation commits first and this read sees `is_active = 0`. Before
 * this, every writer checked with a plain read outside its transaction, or not at all,
 * and both orders could interleave into a follow-up held by a deactivated account.
 * A transaction that loses a lock race anyway (deadlock, lock wait) is rolled back whole
 * and answered with a 409 `try_again` by the error handler.
 *
 * THE RULES, in order:
 *
 *   1. An explicit assignee — honoured only from a supervisor or above. Must exist and be
 *      able to take work, or the request is refused (400, the long-standing message).
 *   2. A telecaller books for themselves. If their own account can no longer take work —
 *      deactivated, with an access token that has not yet expired, or an offline queue
 *      replaying — the follow-up is stored UNASSIGNED rather than refused. Refusing
 *      would drop the queued item on the handset permanently, and the commitment made to
 *      the customer with it; unassigned, it is visible to a supervisor and nothing is lost.
 *   3. A supervisor or above with no explicit choice: the lead's owner if they can take
 *      work (an admin booking a call on a telecaller's lead means the telecaller should
 *      make it), else the actor, else unassigned.
 */
export async function resolveFollowUpAssigneeTx(
  connection: PoolConnection,
  { actor, explicit, leadOwner }: { actor: Actor; explicit?: number | null; leadOwner: number | null },
): Promise<number | null> {
  const supervisorOrAbove = hasRole(actor, 'supervisor');

  if (supervisorOrAbove && explicit !== undefined && explicit !== null) {
    const chosen = await lockAssignableEmployeeTx(connection, explicit);
    if (!chosen) throw badRequest('The chosen employee does not exist.');
    if (!chosen.assignable) throw badRequest('That employee is deactivated.');
    return chosen.id;
  }

  if (supervisorOrAbove && leadOwner !== null) {
    const owner = await lockAssignableEmployeeTx(connection, leadOwner);
    if (owner?.assignable) return owner.id;
  }

  const self = await lockAssignableEmployeeTx(connection, actor.id);
  return self?.assignable ? self.id : null;
}

/**
 * The timeline line for a newly booked follow-up, shared by every path that books one
 * (the follow-ups screen, a status change, a logged call, a call write-up) so they read
 * alike. Says so when nobody could be given the call, because an unassigned follow-up
 * is otherwise invisible until a supervisor goes looking for it.
 */
export function followUpScheduledSummary(
  actorName: string,
  assignedTo: number | null,
  dueAt?: Date,
): string {
  const when = dueAt ? ` for ${formatCompanyDateTime(dueAt)}` : '';
  const who = assignedTo === null ? ', not assigned to anyone yet' : '';
  return `${actorName} scheduled a follow-up${when}${who}`;
}

export async function createFollowUp(
  input: CreateFollowUpInput,
  actor: Actor,
): Promise<{ followUp: FollowUpRecord; deduplicated: boolean }> {
  if (input.clientUuid) {
    const existing = await findFollowUpByClientUuid(input.clientUuid);
    if (existing) return { followUp: existing, deduplicated: true };
  }

  const lead = await findLeadOwner(input.leadId);
  if (!lead) throw notFound('Lead not found.');
  if (!canActOnOwner(actor, lead.assignedTo)) throw notFound('Lead not found.');

  const { followUpId, assignedTo } = await withTransaction(async (connection) => {
    /*
     * Resolved here, inside the transaction, and not before it: the assignee's row is
     * share-locked until this commits, which is what keeps a concurrent deactivation
     * from slipping between the check and the insert. See resolveFollowUpAssigneeTx.
     */
    const assignee = await resolveFollowUpAssigneeTx(connection, {
      actor,
      explicit: input.assignedTo,
      leadOwner: lead.assignedTo,
    });

    /*
     * The lead next, exclusively — the protocol's second step. Inserting first would take
     * only the foreign key's share lock on the lead and upgrade it to exclusive at the
     * cache refresh below; a move that queued for the lead in between turns that upgrade
     * into a deadlock. Locked up front, the two simply wait their turn.
     */
    const [lockedLead] = await lockLeadsForUpdateTx(connection, [input.leadId]);
    if (!lockedLead) throw notFound('Lead not found.');

    const id = await insertFollowUpTx(connection, {
      leadId: input.leadId,
      assignedTo: assignee,
      createdBy: actor.id,
      dueAt: input.dueAt,
      note: input.note,
      clientUuid: input.clientUuid,
    });

    await recordActivityTx(connection, {
      leadId: input.leadId,
      userId: actor.id,
      type: 'follow_up_created',
      summary: followUpScheduledSummary(actor.name, assignee),
      meta: { followUpId: id, dueAt: input.dueAt.toISOString(), assignedTo: assignee },
    });

    await refreshLeadCachesTx(connection, input.leadId);
    return { followUpId: id, assignedTo: assignee };
  });

  const followUp = await findFollowUp(followUpId, null);
  if (!followUp) throw notFound('Follow-up not found after creation.');

  if (assignedTo !== null && assignedTo !== actor.id) {
    await queueNotification({
      userId: assignedTo,
      kind: 'follow_up_due',
      title: 'Follow-up assigned to you',
      // IST whatever the host's zone. A toLocaleString without one printed the server's
      // own clock, so on a UTC host a 6pm call read as 12:30pm on the employee's phone.
      body: `${followUp.leadName} — ${formatCompanyDateTime(followUp.dueAt)}`,
      leadId: followUp.leadId,
      followUpId: followUp.id,
    });
  }

  return { followUp, deduplicated: false };
}

/**
 * Completes a follow-up.
 *
 * An already-completed follow-up is returned as a success rather than an error. The
 * offline queue retries, and two telecallers do not race on the same follow-up — so
 * "already done" is the correct answer, not a conflict to report.
 */
export async function completeFollowUp(
  id: number,
  outcomeNote: string | null,
  actor: Actor,
): Promise<FollowUpRecord> {
  const existing = await findFollowUp(id, ownershipScope(actor));
  if (!existing) throw notFound('Follow-up not found.');

  if (existing.state !== 'pending') return existing;

  await withTransaction(async (connection) => {
    const applied = await completeFollowUpTx(connection, id, actor.id, outcomeNote);

    if (applied) {
      await recordActivityTx(connection, {
        leadId: existing.leadId,
        userId: actor.id,
        type: 'follow_up_completed',
        summary: existing.isOverdue
          ? `${actor.name} completed a follow-up that was overdue`
          : `${actor.name} completed a follow-up`,
        meta: {
          followUpId: id,
          dueAt: existing.dueAt,
          wasOverdue: existing.isOverdue,
        },
      });

      await refreshLeadCachesTx(connection, existing.leadId);
    }
  });

  const after = await findFollowUp(id, null);
  if (!after) throw notFound('Follow-up not found.');
  return after;
}

export async function rescheduleFollowUp(
  id: number,
  dueAt: Date,
  note: string | null,
  actor: Actor,
): Promise<FollowUpRecord> {
  const existing = await findFollowUp(id, ownershipScope(actor));
  if (!existing) throw notFound('Follow-up not found.');

  if (existing.state !== 'pending') {
    throw badRequest('Only a pending follow-up can be rescheduled.');
  }

  await withTransaction(async (connection) => {
    const applied = await rescheduleFollowUpTx(connection, id, dueAt, note);
    if (!applied) return;

    await recordActivityTx(connection, {
      leadId: existing.leadId,
      userId: actor.id,
      type: 'follow_up_rescheduled',
      summary: `${actor.name} moved a follow-up from ${formatCompanyDateTime(existing.dueAt)} to ${formatCompanyDateTime(dueAt)}`,
      meta: {
        followUpId: id,
        from: existing.dueAt,
        to: dueAt.toISOString(),
        rescheduleCount: existing.rescheduleCount + 1,
      },
    });

    await refreshLeadCachesTx(connection, existing.leadId);
  });

  const after = await findFollowUp(id, null);
  if (!after) throw notFound('Follow-up not found.');
  return after;
}

export async function cancelFollowUp(id: number, actor: Actor): Promise<FollowUpRecord> {
  const existing = await findFollowUp(id, ownershipScope(actor));
  if (!existing) throw notFound('Follow-up not found.');
  if (existing.state !== 'pending') return existing;

  await withTransaction(async (connection) => {
    const applied = await cancelFollowUpTx(connection, id);
    if (!applied) return;

    await recordActivityTx(connection, {
      leadId: existing.leadId,
      userId: actor.id,
      type: 'follow_up_cancelled',
      summary: `${actor.name} cancelled a follow-up`,
      meta: { followUpId: id, dueAt: existing.dueAt },
    });

    await refreshLeadCachesTx(connection, existing.leadId);
  });

  const after = await findFollowUp(id, null);
  if (!after) throw notFound('Follow-up not found.');
  return after;
}

/*
 * Editing (a note, or who holds it), moving and handing over live in
 * `followUpMove.service.ts`: a move can transfer the lead, and `lead.service.ts` imports
 * this module, so keeping them here would make the two import each other.
 */
