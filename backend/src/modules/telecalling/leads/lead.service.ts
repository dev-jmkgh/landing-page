import { withTransaction } from '../../../db/pool';
import { badRequest, forbidden, notFound } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { createReference } from '../../../utils/text';
import { canActOnOwner, hasRole, ownershipScope, type Actor } from '../actor';
import { recordActivity, recordActivityTx, recordAudit } from '../activity/activity.repository';
import { findEmployee } from '../employees/employee.repository';
import { queueNotification } from '../notifications/notification.repository';
import { CLOSED_LEAD_STATUSES, type LeadStatus } from '../shared.schema';
import {
  archiveLead,
  assignLeadTx,
  findDuplicateByPhone,
  findLead,
  findLeadByClientUuid,
  findLeadOwner,
  findNoteByClientUuid,
  insertLeadTx,
  insertNoteTx,
  leadSourceExists,
  listLeadNotes,
  refreshLeadCachesTx,
  updateLeadFields,
  updateLeadStatusTx,
  type LeadNoteRecord,
  type LeadRecord,
} from './lead.repository';
import type {
  BulkAssignInput,
  CreateLeadInput,
  LeadNoteInput,
  LeadStatusInput,
  UpdateLeadInput,
} from './lead.schema';

/**
 * Lead business rules.
 *
 * Everything that changes a lead *and* records what happened runs in one transaction.
 * An activity row that can be missing while the change it describes succeeded makes the
 * timeline untrustworthy — and a timeline nobody trusts gets ignored at exactly the
 * moment it matters, which is when a customer disputes what was said.
 */

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

export type CreateLeadResult = {
  lead: LeadRecord;
  /** An existing lead with the same number, when one was found. Advisory, not a block. */
  possibleDuplicate: LeadRecord | null;
  /** True when this request was a retry of one that had already been applied. */
  deduplicated: boolean;
};

/**
 * Creates a lead.
 *
 * A duplicate phone number does **not** reject the request. Two leads can legitimately
 * share a number, and a telecaller with a paper lead in hand and a customer waiting
 * cannot be told to go and reconcile the database first. The existing lead is returned
 * alongside the new one so the app can offer to open it instead — the decision belongs
 * to the person who can see both.
 */
export async function createLead(
  input: CreateLeadInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<CreateLeadResult> {
  // Offline-queue retry: the note carrying this key was already written, so the lead
  // exists. Return it rather than creating a second copy.
  if (input.clientUuid) {
    const existing = await findLeadByClientUuid(input.clientUuid);
    if (existing) {
      return { lead: existing, possibleDuplicate: null, deduplicated: true };
    }
  }

  /**
   * Who owns the new lead.
   *
   * A telecaller always gets their own id, whatever they sent — they have no way to
   * assign work to a colleague, and honouring `assignedTo` from that client would be a
   * privilege escalation dressed as a field. Above that rank the field is respected,
   * and defaults to the creator so a lead is never accidentally created ownerless by
   * someone who intended to work it themselves.
   */
  let assignedTo: number | null;
  if (!hasRole(actor, 'supervisor')) {
    assignedTo = actor.id;
  } else if (input.assignedTo === undefined) {
    assignedTo = actor.id;
  } else {
    assignedTo = input.assignedTo;
  }

  if (assignedTo !== null) {
    const owner = await findEmployee(assignedTo);
    if (!owner) throw badRequest('The chosen employee does not exist.');
    if (!owner.isActive) throw badRequest('That employee is deactivated and cannot take leads.');
  }

  // An unknown source is accepted and normalised to 'other' rather than rejected: the
  // sources table is admin-editable, and a lead should never be lost because a source
  // was renamed between the app loading its options and the telecaller pressing save.
  const source = (await leadSourceExists(input.source)) ? input.source : 'other';
  if (source !== input.source) {
    logger.warn('Unknown lead source normalised to "other"', { requested: input.source });
  }

  const possibleDuplicate = await findDuplicateByPhone(input.phone);

  const leadId = await withTransaction(async (connection) => {
    const id = await insertLeadTx(connection, {
      reference: createReference('LD'),
      customerName: input.customerName,
      phone: input.phone,
      alternatePhone: input.alternatePhone,
      email: input.email,
      address: input.address,
      city: input.city,
      source,
      productInterest: input.productInterest,
      status: input.status,
      assignedTo,
      assignedBy: assignedTo === null ? null : actor.id,
      createdBy: actor.id,
      enquiryId: input.enquiryId ?? null,
      attachmentKey: input.attachmentKey,
      attachmentMime: null,
      summaryNote: input.summaryNote,
    });

    await recordActivityTx(connection, {
      leadId: id,
      userId: actor.id,
      type: 'lead_created',
      summary: `${actor.name} created this lead from ${source.replace(/_/g, ' ')}`,
      meta: { source, status: input.status, assignedTo },
    });

    if (assignedTo !== null && assignedTo !== actor.id) {
      await recordActivityTx(connection, {
        leadId: id,
        userId: actor.id,
        type: 'lead_assigned',
        summary: `${actor.name} assigned this lead`,
        meta: { assignedTo },
      });
    }

    /**
     * The idempotency key is anchored on a note rather than on the lead.
     *
     * `leads` has no `client_uuid` column, and adding one would be a unique index on a
     * mostly-NULL column of the largest table in the schema. A system note carries the
     * key instead, and `findLeadByClientUuid` looks the lead up through it — which also
     * leaves a visible trace of where the lead came from.
     */
    if (input.clientUuid) {
      await insertNoteTx(connection, {
        leadId: id,
        userId: actor.id,
        kind: 'system',
        body: 'Lead created from the mobile app.',
        callId: null,
        clientUuid: input.clientUuid,
      });
    }

    return id;
  });

  const lead = await findLead(leadId, null);
  if (!lead) throw notFound('Lead not found after creation.');

  await recordAudit({
    actor,
    action: 'lead_created',
    entityType: 'lead',
    entityId: leadId,
    summary: `Created lead ${lead.reference} for ${lead.customerName}`,
    meta: { source, assignedTo },
    ipAddress,
  });

  if (assignedTo !== null && assignedTo !== actor.id) {
    await queueNotification({
      userId: assignedTo,
      kind: 'lead_assigned',
      title: 'New lead assigned',
      body: `${lead.customerName} — ${lead.phone}`,
      leadId: lead.id,
    });
  }

  return { lead, possibleDuplicate, deduplicated: false };
}

/* -------------------------------------------------------------------------- */
/* Update                                                                      */
/* -------------------------------------------------------------------------- */

export async function editLead(
  id: number,
  input: UpdateLeadInput,
  actor: Actor,
): Promise<LeadRecord> {
  const before = await findLead(id, ownershipScope(actor));
  if (!before) throw notFound('Lead not found.');

  const changed = await updateLeadFields(id, input);
  if (!changed) throw badRequest('Nothing to update.');

  const after = await findLead(id, ownershipScope(actor));
  if (!after) throw notFound('Lead not found.');

  const changes = diffLead(before, after);

  /**
   * No activity row for a no-op edit — a timeline full of "updated this lead" entries
   * that record nothing is worse than one that omits them.
   *
   * This is logged outside a transaction, unlike every other change in this file. The
   * update above is a single statement that has already committed, so there is no
   * transaction to join, and failing the request over a lost log entry would report a
   * failure for work that succeeded. `recordActivity` logs and swallows its own errors
   * for exactly this case.
   */
  if (Object.keys(changes).length > 0) {
    await recordActivity({
      leadId: id,
      userId: actor.id,
      type: 'lead_updated',
      summary: `${actor.name} updated ${Object.keys(changes).join(', ')}`,
      meta: changes,
    });
  }

  return after;
}

const DIFFED_FIELDS: (keyof LeadRecord)[] = [
  'customerName',
  'phone',
  'alternatePhone',
  'email',
  'address',
  'city',
  'source',
  'productInterest',
  'summaryNote',
];

function diffLead(before: LeadRecord, after: LeadRecord): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of DIFFED_FIELDS) {
    if (before[field] !== after[field]) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

export type StatusChangeResult = {
  lead: LeadRecord;
  followUpId: number | null;
};

/**
 * Changes a lead's status, optionally booking the follow-up in the same breath.
 *
 * One transaction covering the status, the note, the follow-up and both activity rows.
 * The alternative — three requests from a phone on a weak connection — can leave a lead
 * marked `follow_up` with no follow-up attached, which is the single most common way
 * for a lead to be forgotten.
 */
export async function changeLeadStatus(
  id: number,
  input: LeadStatusInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<StatusChangeResult> {
  const before = await findLead(id, ownershipScope(actor));
  if (!before) throw notFound('Lead not found.');

  if (input.followUpAt && input.followUpAt.getTime() < Date.now() - 60_000) {
    throw badRequest('Choose a follow-up time in the future.');
  }

  const followUpId = await withTransaction(async (connection) => {
    let createdFollowUpId: number | null = null;

    if (before.status !== input.status) {
      await updateLeadStatusTx(connection, id, input.status);
      await recordActivityTx(connection, {
        leadId: id,
        userId: actor.id,
        type: 'status_changed',
        summary: `${actor.name} changed the status from ${label(before.status)} to ${label(input.status)}`,
        meta: { from: before.status, to: input.status },
      });
    }

    if (input.note) {
      await insertNoteTx(connection, {
        leadId: id,
        userId: actor.id,
        kind: 'note',
        body: input.note,
        callId: null,
        clientUuid: input.clientUuid,
      });
      await recordActivityTx(connection, {
        leadId: id,
        userId: actor.id,
        type: 'note_added',
        summary: `${actor.name} added a note`,
        meta: null,
      });
    }

    if (input.followUpAt) {
      const [result] = await connection.execute(
        `INSERT INTO follow_ups (lead_id, assigned_to, created_by, due_at, note)
         VALUES (?, ?, ?, ?, ?)`,
        [id, before.assignedTo ?? actor.id, actor.id, input.followUpAt, input.followUpNote],
      );
      createdFollowUpId = (result as { insertId: number }).insertId;

      await recordActivityTx(connection, {
        leadId: id,
        userId: actor.id,
        type: 'follow_up_created',
        summary: `${actor.name} scheduled a follow-up for ${input.followUpAt.toISOString()}`,
        meta: { dueAt: input.followUpAt.toISOString(), followUpId: createdFollowUpId },
      });
    }

    // The follow-up cache has to be recomputed inside this transaction, or a lead list
    // read a moment later would sort by a stale next-follow-up date.
    await refreshLeadCachesTx(connection, id);

    return createdFollowUpId;
  });

  const lead = await findLead(id, null);
  if (!lead) throw notFound('Lead not found.');

  if (before.status !== input.status) {
    await recordAudit({
      actor,
      action: 'lead_status_changed',
      entityType: 'lead',
      entityId: id,
      summary: `Lead ${lead.reference}: ${label(before.status)} to ${label(input.status)}`,
      meta: { from: before.status, to: input.status },
      ipAddress,
    });
  }

  return { lead, followUpId };
}

function label(status: LeadStatus): string {
  return status.replace(/_/g, ' ');
}

/* -------------------------------------------------------------------------- */
/* Assignment                                                                  */
/* -------------------------------------------------------------------------- */

export async function assignLead(
  id: number,
  assignedTo: number | null,
  reason: string | null,
  actor: Actor,
  ipAddress: string | null,
): Promise<LeadRecord> {
  const before = await findLead(id, null);
  if (!before) throw notFound('Lead not found.');

  if (assignedTo !== null) {
    const owner = await findEmployee(assignedTo);
    if (!owner) throw badRequest('The chosen employee does not exist.');
    if (!owner.isActive) throw badRequest('That employee is deactivated and cannot take leads.');
  }

  if (before.assignedTo === assignedTo) {
    // Not an error — a bulk operation may legitimately include a lead that is already
    // where it should be — but nothing to record either.
    return before;
  }

  const previousOwner = before.assignedToName;

  await withTransaction(async (connection) => {
    await assignLeadTx(connection, id, assignedTo, actor.id);

    // Any pending follow-up moves with the lead. Leaving it behind means the new owner
    // never sees the commitment and the previous owner is chased for a lead they no
    // longer hold.
    if (assignedTo !== null) {
      await connection.execute(
        `UPDATE follow_ups SET assigned_to = ? WHERE lead_id = ? AND state = 'pending'`,
        [assignedTo, id],
      );
    }

    const type =
      assignedTo === null ? 'lead_unassigned' : before.assignedTo === null ? 'lead_assigned' : 'lead_reassigned';

    const summary =
      assignedTo === null
        ? `${actor.name} returned this lead to the unassigned pool`
        : before.assignedTo === null
          ? `${actor.name} assigned this lead`
          : `${actor.name} reassigned this lead from ${previousOwner ?? 'a former employee'}`;

    await recordActivityTx(connection, {
      leadId: id,
      userId: actor.id,
      type,
      summary,
      meta: { from: before.assignedTo, to: assignedTo, reason },
    });
  });

  const after = await findLead(id, null);
  if (!after) throw notFound('Lead not found.');

  await recordAudit({
    actor,
    action: assignedTo === null ? 'lead_unassigned' : 'lead_assigned',
    entityType: 'lead',
    entityId: id,
    summary: `Lead ${after.reference} assigned to ${after.assignedToName ?? 'nobody'}`,
    meta: { from: before.assignedTo, to: assignedTo, reason },
    ipAddress,
  });

  if (assignedTo !== null && assignedTo !== actor.id) {
    await queueNotification({
      userId: assignedTo,
      kind: 'lead_assigned',
      title: 'New lead assigned',
      body: `${after.customerName} — ${after.phone}`,
      leadId: id,
    });
  }

  return after;
}

export type BulkAssignResult = {
  assigned: number;
  skipped: number;
  /** Ids that could not be assigned, so the UI can name them rather than say "some". */
  failedIds: number[];
};

/**
 * Bulk assignment.
 *
 * Each lead is assigned individually rather than in one UPDATE ... WHERE id IN (...),
 * because every one needs its own activity row, and a single statement would give a
 * batch of two hundred leads no history at all. Failures are collected rather than
 * thrown: an admin assigning two hundred leads should not lose the other 199 because
 * one was deleted a moment ago.
 */
export async function bulkAssignLeads(
  input: BulkAssignInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<BulkAssignResult> {
  if (input.assignedTo !== null) {
    const owner = await findEmployee(input.assignedTo);
    if (!owner) throw badRequest('The chosen employee does not exist.');
    if (!owner.isActive) throw badRequest('That employee is deactivated and cannot take leads.');
  }

  const unique = [...new Set(input.leadIds)];
  const failedIds: number[] = [];
  let assigned = 0;

  for (const leadId of unique) {
    try {
      const before = await findLeadOwner(leadId);
      if (!before) {
        failedIds.push(leadId);
        continue;
      }
      if (before.assignedTo === input.assignedTo) continue;

      await assignLead(leadId, input.assignedTo, input.reason, actor, null);
      assigned += 1;
    } catch (error) {
      logger.warn('Bulk assign skipped a lead', {
        leadId,
        message: error instanceof Error ? error.message : String(error),
      });
      failedIds.push(leadId);
    }
  }

  await recordAudit({
    actor,
    action: 'leads_bulk_assigned',
    entityType: 'lead',
    entityId: null,
    summary: `Bulk assigned ${assigned} lead(s) to employee ${input.assignedTo ?? 'nobody'}`,
    meta: { requested: unique.length, assigned, failed: failedIds.length, reason: input.reason },
    ipAddress,
  });

  return { assigned, skipped: unique.length - assigned - failedIds.length, failedIds };
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

export async function addLeadNote(
  leadId: number,
  input: LeadNoteInput,
  actor: Actor,
): Promise<{ note: LeadNoteRecord; deduplicated: boolean }> {
  if (input.clientUuid) {
    const existing = await findNoteByClientUuid(input.clientUuid);
    if (existing) return { note: existing, deduplicated: true };
  }

  const lead = await findLeadOwner(leadId);
  if (!lead) throw notFound('Lead not found.');
  if (!canActOnOwner(actor, lead.assignedTo)) throw notFound('Lead not found.');

  const noteId = await withTransaction(async (connection) => {
    const id = await insertNoteTx(connection, {
      leadId,
      userId: actor.id,
      kind: input.kind,
      body: input.body,
      callId: input.callId ?? null,
      clientUuid: input.clientUuid,
    });

    await recordActivityTx(connection, {
      leadId,
      userId: actor.id,
      type: 'note_added',
      summary:
        input.kind === 'requirement'
          ? `${actor.name} recorded the customer's requirements`
          : `${actor.name} added a note`,
      meta: { noteId: id, kind: input.kind },
    });

    return id;
  });

  // Read back the newest note rather than composing the record in memory, so the
  // response carries the author name the join supplies and the timestamp the database
  // actually stored.
  const notes = await listLeadNotes(leadId, 5);
  const note = notes.find((candidate) => candidate.id === noteId);
  if (!note) throw notFound('Note not found after creation.');

  return { note, deduplicated: false };
}

/* -------------------------------------------------------------------------- */
/* Archive and delete                                                          */
/* -------------------------------------------------------------------------- */

export async function setLeadArchived(
  id: number,
  archived: boolean,
  actor: Actor,
  ipAddress: string | null,
): Promise<LeadRecord> {
  const lead = await findLead(id, null);
  if (!lead) throw notFound('Lead not found.');
  if (lead.isArchived === archived) return lead;

  await archiveLead(id, archived);

  await recordActivity({
    leadId: id,
    userId: actor.id,
    type: archived ? 'lead_archived' : 'lead_restored',
    summary: `${actor.name} ${archived ? 'archived' : 'restored'} this lead`,
    meta: null,
  });

  await recordAudit({
    actor,
    action: archived ? 'lead_archived' : 'lead_restored',
    entityType: 'lead',
    entityId: id,
    summary: `${archived ? 'Archived' : 'Restored'} lead ${lead.reference}`,
    ipAddress,
  });

  const after = await findLead(id, null);
  if (!after) throw notFound('Lead not found.');
  return after;
}

/**
 * Whether a lead is still open work, for the "pending" counts.
 *
 * Exported because both the mobile dashboard and the admin performance screen need the
 * same definition, and two definitions of "open" would make the two screens disagree
 * about the same employee.
 */
export function isOpenStatus(status: LeadStatus): boolean {
  return !CLOSED_LEAD_STATUSES.includes(status);
}

/** Guards a write against a lead the actor may not touch. */
export async function assertCanWriteLead(id: number, actor: Actor): Promise<void> {
  const lead = await findLeadOwner(id);
  if (!lead) throw notFound('Lead not found.');
  if (!canActOnOwner(actor, lead.assignedTo)) {
    // 404 rather than 403: a 403 confirms the lead exists and belongs to someone else,
    // which is what an employee walking ids is trying to find out.
    throw notFound('Lead not found.');
  }
}

/** Used by the routes that need to distinguish "cannot" from "does not exist". */
export function forbidUnlessSupervisor(actor: Actor): void {
  if (!hasRole(actor, 'supervisor')) {
    throw forbidden('You do not have permission to do that.');
  }
}
