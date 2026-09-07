import { withTransaction } from '../../../db/pool';
import { badRequest, notFound } from '../../../utils/httpError';
import { canActOnOwner, hasRole, ownershipScope, type Actor } from '../actor';
import { recordActivity, recordActivityTx } from '../activity/activity.repository';
import { findEmployee } from '../employees/employee.repository';
import { findLeadOwner, refreshLeadCachesTx } from '../leads/lead.repository';
import { queueNotification } from '../notifications/notification.repository';
import {
  cancelFollowUpTx,
  completeFollowUpTx,
  findFollowUp,
  findFollowUpByClientUuid,
  insertFollowUpTx,
  rescheduleFollowUpTx,
  updateFollowUpFields,
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

  /**
   * Who owes the call.
   *
   * A telecaller always gets themselves — they cannot hand work to a colleague. Above
   * that rank, an explicit assignee is honoured; otherwise it falls to the lead's owner
   * rather than to the admin creating it, since an admin booking a follow-up on a
   * telecaller's lead means the telecaller should make the call.
   */
  let assignedTo: number;

  if (!hasRole(actor, 'supervisor')) {
    assignedTo = actor.id;
  } else if (input.assignedTo !== undefined) {
    const assignee = await findEmployee(input.assignedTo);
    if (!assignee) throw badRequest('The chosen employee does not exist.');
    if (!assignee.isActive) throw badRequest('That employee is deactivated.');
    assignedTo = input.assignedTo;
  } else {
    assignedTo = lead.assignedTo ?? actor.id;
  }

  const followUpId = await withTransaction(async (connection) => {
    const id = await insertFollowUpTx(connection, {
      leadId: input.leadId,
      assignedTo,
      createdBy: actor.id,
      dueAt: input.dueAt,
      note: input.note,
      clientUuid: input.clientUuid,
    });

    await recordActivityTx(connection, {
      leadId: input.leadId,
      userId: actor.id,
      type: 'follow_up_created',
      summary: `${actor.name} scheduled a follow-up`,
      meta: { followUpId: id, dueAt: input.dueAt.toISOString(), assignedTo },
    });

    await refreshLeadCachesTx(connection, input.leadId);
    return id;
  });

  const followUp = await findFollowUp(followUpId, null);
  if (!followUp) throw notFound('Follow-up not found after creation.');

  if (assignedTo !== actor.id) {
    await queueNotification({
      userId: assignedTo,
      kind: 'follow_up_due',
      title: 'Follow-up assigned to you',
      body: `${followUp.leadName} — ${new Date(followUp.dueAt).toLocaleString('en-IN')}`,
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
      summary: `${actor.name} moved a follow-up from ${formatIst(existing.dueAt)} to ${formatIst(dueAt.toISOString())}`,
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

/**
 * Reassigns or re-notes a follow-up. Supervisor and above (spec: Admin Module 8).
 *
 * Deliberately not available to a telecaller even for their own follow-up: handing work
 * to a colleague is a scheduling decision, and the person who has to make the call is
 * not the person who should decide it is someone else's problem.
 */
export async function editFollowUp(
  id: number,
  fields: { note?: string | null; assignedTo?: number },
  actor: Actor,
): Promise<FollowUpRecord> {
  const existing = await findFollowUp(id, null);
  if (!existing) throw notFound('Follow-up not found.');

  if (fields.assignedTo !== undefined) {
    const assignee = await findEmployee(fields.assignedTo);
    if (!assignee) throw badRequest('The chosen employee does not exist.');
    if (!assignee.isActive) throw badRequest('That employee is deactivated.');
  }

  const changed = await updateFollowUpFields(id, fields);
  if (!changed) throw badRequest('Nothing to update.');

  const after = await findFollowUp(id, null);
  if (!after) throw notFound('Follow-up not found.');

  if (fields.assignedTo !== undefined && fields.assignedTo !== existing.assignedTo) {
    await recordActivity({
      leadId: existing.leadId,
      userId: actor.id,
      type: 'follow_up_rescheduled',
      summary: `${actor.name} reassigned a follow-up to ${after.assignedToName ?? 'another employee'}`,
      meta: { followUpId: id, from: existing.assignedTo, to: fields.assignedTo },
    });

    await queueNotification({
      userId: fields.assignedTo,
      kind: 'follow_up_due',
      title: 'Follow-up assigned to you',
      body: `${after.leadName} — ${formatIst(after.dueAt)}`,
      leadId: after.leadId,
      followUpId: after.id,
    });
  }

  return after;
}

/**
 * Timestamps in activity summaries are rendered in IST.
 *
 * The summary is stored as text and read by people in one office. A UTC timestamp in
 * a timeline line is technically precise and practically useless to the telecaller
 * reading it.
 */
function formatIst(isoString: string): string {
  return new Date(isoString).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
