import type { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../../../db/pool';
import { badRequest, forbidden, notFound } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { createReference } from '../../../utils/text';
import {
  canActOnOwner,
  hasRole,
  ownershipScope,
  type Actor,
  type OwnershipScope,
} from '../actor';
import {
  listCallStatusChanges,
  recordActivity,
  recordActivityTx,
  recordAudit,
  type ActivityRecord,
  type CallStatusChange,
} from '../activity/activity.repository';
import {
  adoptOrphanCallsTx,
  findCall,
  leadCallSummary,
  listLeadCallsPage,
  type CallRecord,
  type LeadCallSummary,
} from '../calls/call.repository';
import {
  findEmployee,
  findEmployeeNameTx,
  lockAssignableEmployeeTx,
} from '../employees/employee.repository';
import {
  insertFollowUpTx,
  listCallFollowUps,
  reassignLeadPendingFollowUpsTx,
  type FollowUpRecord,
} from '../followups/followUp.repository';
import {
  followUpScheduledSummary,
  resolveFollowUpAssigneeTx,
} from '../followups/followUp.service';
import { queueNotification } from '../notifications/notification.repository';
import {
  CLOSED_LEAD_STATUSES,
  type EmployeeRole,
  type LeadStatus,
  type Paginated,
} from '../shared.schema';
import {
  archiveLead,
  assignLeadTx,
  findDuplicateByPhone,
  findLead,
  findLeadByClientUuid,
  findLeadDetail,
  findLeadOwner,
  findNoteByClientUuid,
  insertLeadTx,
  insertNoteTx,
  LATEST_NOTE_PREVIEW_LENGTH,
  leadSourceExists,
  listLeadCallNotes,
  listLatestLeadNotes,
  listLeadNotes,
  listLeadNotesPage,
  listLeads,
  lockLeadsForUpdateTx,
  refreshLeadCachesTx,
  updateLeadFields,
  updateLeadStatusTx,
  type LatestLeadNote,
  type LeadDetailRecord,
  type LeadNoteRecord,
  type LeadRecord,
} from './lead.repository';
import {
  LEAD_VIEW_PAGE_SIZE,
  type BulkAssignInput,
  type CreateLeadInput,
  type LeadListQuery,
  type LeadNoteInput,
  type LeadStatusInput,
  type UpdateLeadInput,
} from './lead.schema';
import {
  countLeadHistory,
  listLeadActivityPage,
  listLeadClosedFollowUpsPage,
  listLeadPendingFollowUps,
  type LeadHistoryCounts,
} from './leadView.repository';

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
 * Where a new lead came from. `direct` is a person filling in the form in either app;
 * `import` is one row of a spreadsheet, named so its timeline can say so and the import
 * can be traced from the lead.
 */
export type CreateLeadOrigin =
  | { kind: 'direct' }
  | { kind: 'import'; importId: number; sheetRow: number };

/**
 * How `createLead` reports what it did. Every default is the behaviour of a single
 * create, so the routes pass nothing.
 *
 * A spreadsheet import creates up to two thousand leads through this same function —
 * every rule (ownership, active owner, the one-lead-per-number refusal, call adoption,
 * activity in the same transaction) stays identical — but it reports once for the whole
 * file: one audit row and one notification per assignee, sent by the import, instead of
 * two thousand of each.
 */
export type CreateLeadOptions = {
  origin?: CreateLeadOrigin;
  /** Notify a new owner who is not the creator. Default true. */
  notifyAssignee?: boolean;
  /** Write the per-lead `lead_created` audit row. Default true. */
  audit?: boolean;
};

/**
 * The refusal for a number another active lead already holds.
 *
 * It names that lead only to someone allowed to see it. A telecaller who enters a
 * colleague's customer's number is told the number is taken and nothing more: the name
 * and reference would reveal a record outside their ownership scope, and repeated tries
 * would turn this endpoint into a lookup of who the company's customers are. The check
 * itself stays global — a scoped lookup would let a second lead be made for a
 * colleague's customer, which is exactly what it exists to stop.
 */
function duplicateNumber(
  existing: { customerName: string; reference: string; assignedTo: number | null },
  actor: Actor,
) {
  if (!canActOnOwner(actor, existing.assignedTo)) {
    return badRequest('This number is already on another lead.', {
      phone: 'Already on another lead. Ask your supervisor if this customer should be yours.',
    });
  }

  return badRequest(`${existing.customerName} (${existing.reference}) already has this number.`, {
    // Named against the field so both the app and the admin form show it under the
    // number rather than as a banner the telecaller has to interpret.
    phone: `Already used by ${existing.customerName} (${existing.reference}).`,
  });
}

/**
 * Creates a lead.
 *
 * A number another active lead already holds is refused (see the check below and
 * `duplicateNumber`): one customer with two half-histories was worse than asking the
 * employee to open the existing lead.
 */
export async function createLead(
  input: CreateLeadInput,
  actor: Actor,
  ipAddress: string | null,
  options: CreateLeadOptions = {},
): Promise<CreateLeadResult> {
  const origin: CreateLeadOrigin = options.origin ?? { kind: 'direct' };
  const notifyAssignee = options.notifyAssignee ?? true;
  const audit = options.audit ?? true;

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

  /**
   * One active lead per number. A second is refused, not flagged.
   *
   * This used to create the lead anyway and report the clash as advice, on the reasoning
   * that a household can share a handset. In practice the field never worked that way:
   * the duplicate was created, both records accumulated half a history each, and calls
   * from that number stopped attaching to either because the server will not guess
   * between two matches. One customer ended up with two partial records and an Incoming
   * list that could not place their calls.
   *
   * Matched on the trailing digits and only against ACTIVE leads, so archiving a record
   * releases its number — see migration 015, which enforces the same rule in the schema
   * for the two-requests-at-once case this check cannot see.
   */
  const existingForPhone = await findDuplicateByPhone(input.phone);

  if (existingForPhone) throw duplicateNumber(existingForPhone, actor);

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

    /*
     * An imported lead says so, in words a telecaller reads, and carries the import and
     * sheet row in `meta` for the trace back. The type stays `lead_created`: an unknown
     * type renders as a blank row in both clients' timelines.
     */
    await recordActivityTx(connection, {
      leadId: id,
      userId: actor.id,
      type: 'lead_created',
      summary:
        origin.kind === 'import'
          ? `${actor.name} added this lead from a spreadsheet (${source.replace(/_/g, ' ')})`
          : `${actor.name} created this lead from ${source.replace(/_/g, ' ')}`,
      meta:
        origin.kind === 'import'
          ? {
              source,
              status: input.status,
              assignedTo,
              importId: origin.importId,
              sheetRow: origin.sheetRow,
            }
          : { source, status: input.status, assignedTo },
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
     * Calls from this number that belonged to nobody now belong to this lead.
     *
     * The unknown-caller path: a customer rings, the call is imported from the handset's
     * call log with no lead to attach to, and the employee taps "Create lead" on it. The
     * conversation that produced the lead has to be in the lead's history, or the record
     * opens claiming no one has ever spoken to this person.
     *
     * Runs for every lead, not only ones created from the Incoming screen — the employee
     * who adds the lead from the Leads tab ten minutes later deserves the same history,
     * and matching on the number rather than on a call id the client passed is what makes
     * that work. It is also why the client sends nothing new: the phone number it already
     * sends is the whole input.
     *
     * Scoped inside `adoptOrphanCallsTx` to the actor's own calls that belong to no lead,
     * so this can neither move a call out of another customer's history nor pull in a
     * colleague's conversations.
     */
    const adopted = await adoptOrphanCallsTx(connection, actor.id, id, [
      input.phone,
      input.alternatePhone,
    ]);

    if (adopted > 0) {
      await recordActivityTx(connection, {
        leadId: id,
        userId: actor.id,
        // One line, not one per call. The activity rows would all be stamped with the
        // moment the lead was created rather than the times the calls happened, so a row
        // each would read as a burst of calls that never occurred.
        type: 'call_logged',
        summary:
          adopted === 1
            ? `Linked an earlier call from this number to ${actor.name}`
            : `Linked ${adopted} earlier calls from this number to ${actor.name}`,
        meta: { adoptedCalls: adopted },
      });

      // The adopted calls are contact: without this the new lead would sit under "not yet
      // called" — a work list — though the employee has already spoken to the customer.
      await refreshLeadCachesTx(connection, id);
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
        body:
          origin.kind === 'import'
            ? `Added from a spreadsheet by ${actor.name} (row ${origin.sheetRow}).`
            : 'Lead created from the mobile app.',
        callId: null,
        clientUuid: input.clientUuid,
      });
    }

    return id;
  });

  const lead = await findLead(leadId, null);
  if (!lead) throw notFound('Lead not found after creation.');

  if (audit) {
    await recordAudit({
      actor,
      action: 'lead_created',
      entityType: 'lead',
      entityId: leadId,
      summary: `Created lead ${lead.reference} for ${lead.customerName}`,
      meta: { source, assignedTo },
      ipAddress,
    });
  }

  if (notifyAssignee && assignedTo !== null && assignedTo !== actor.id) {
    await queueNotification({
      userId: assignedTo,
      kind: 'lead_assigned',
      title: 'New lead assigned',
      body: `${lead.customerName} — ${lead.phone}`,
      leadId: lead.id,
    });
  }

  /*
   * `possibleDuplicate` is always null now and stays in the response on purpose: app
   * builds already in employees' hands read the field, and a create that succeeds without
   * it would be a shape they do not expect. A clash is a 4xx to those builds, which they
   * already render as an error on the form.
   */
  return { lead, possibleDuplicate: null, deduplicated: false };
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

  /*
   * Editing a number into one another lead already holds is the same duplicate by a
   * slower route, so it is refused the same way.
   *
   * Compared on the trailing digits, which is what lets a telecaller tidy
   * `9876543210` into `+91 98765 43210` on the lead that already owns it: the key does
   * not change, `findDuplicateByPhone` returns this very lead, and the id check below
   * lets it through. Only a move onto somebody ELSE's number is stopped.
   */
  if (input.phone !== undefined) {
    const clash = await findDuplicateByPhone(input.phone);

    if (clash && clash.id !== id) throw duplicateNumber(clash, actor);
  }

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
      /*
       * Who owes the call is decided under the assignee's row lock, in this transaction.
       * It used to be `before.assignedTo ?? actor.id` with no check at all, which booked
       * follow-ups onto a lead owner who had already been deactivated.
       */
      const assignee = await resolveFollowUpAssigneeTx(connection, {
        actor,
        leadOwner: before.assignedTo,
      });

      createdFollowUpId = await insertFollowUpTx(connection, {
        leadId: id,
        assignedTo: assignee,
        createdBy: actor.id,
        dueAt: input.followUpAt,
        note: input.followUpNote,
        // No key of its own, as before: the request's clientUuid is stored on the note.
        clientUuid: null,
      });

      await recordActivityTx(connection, {
        leadId: id,
        userId: actor.id,
        type: 'follow_up_created',
        summary: followUpScheduledSummary(actor.name, assignee, input.followUpAt),
        meta: {
          dueAt: input.followUpAt.toISOString(),
          followUpId: createdFollowUpId,
          assignedTo: assignee,
        },
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

/**
 * Moves a lead to a new owner inside the caller's transaction: the lead row, every one of
 * its pending follow-ups, and the timeline entry — all or nothing.
 *
 * Shared by single assignment, and by follow-up moves and handovers that also transfer
 * the lead. The caller must already hold the new owner's employee row
 * (`lockAssignableEmployeeTx` or `lockEmployeesForUpdateTx`), and should hold the lead
 * row (`lockLeadsForUpdateTx`) so `lead.assignedTo` is the owner being replaced — this
 * re-checks neither, which keeps the lock order (employees, leads, follow-ups) the
 * caller's to keep. Audit and notification are post-commit, so they stay with the caller.
 *
 * Every pending follow-up moves with the lead. Leaving one behind means the new owner
 * never sees the commitment and the previous owner is chased for a lead they no longer
 * hold — which also means a later reassignment overrides any earlier per-follow-up move.
 */
export async function reassignLeadInTx(
  connection: PoolConnection,
  lead: {
    id: number;
    reference: string;
    customerName: string;
    assignedTo: number | null;
    /** The current owner's name, for the timeline. Looked up when not supplied. */
    assignedToName?: string | null;
  },
  newOwnerId: number | null,
  reason: string | null,
  actor: Actor,
): Promise<void> {
  await assignLeadTx(connection, lead.id, newOwnerId, actor.id);

  if (newOwnerId !== null) {
    await reassignLeadPendingFollowUpsTx(connection, lead.id, newOwnerId);
  }

  const type =
    newOwnerId === null
      ? 'lead_unassigned'
      : lead.assignedTo === null
        ? 'lead_assigned'
        : 'lead_reassigned';

  let summary: string;
  if (newOwnerId === null) {
    summary = `${actor.name} returned this lead to the unassigned pool`;
  } else if (lead.assignedTo === null) {
    summary = `${actor.name} assigned this lead`;
  } else {
    const previousOwner =
      lead.assignedToName !== undefined
        ? lead.assignedToName
        : await findEmployeeNameTx(connection, lead.assignedTo);
    summary = `${actor.name} reassigned this lead from ${previousOwner ?? 'a former employee'}`;
  }

  await recordActivityTx(connection, {
    leadId: lead.id,
    userId: actor.id,
    type,
    summary,
    meta: { from: lead.assignedTo, to: newOwnerId, reason },
  });
}

export async function assignLead(
  id: number,
  assignedTo: number | null,
  reason: string | null,
  actor: Actor,
  ipAddress: string | null,
): Promise<LeadRecord> {
  const before = await findLead(id, null);
  if (!before) throw notFound('Lead not found.');

  const previousOwnerId = await withTransaction(async (connection) => {
    /*
     * The new owner is re-read under a share lock in this transaction, not checked
     * before it: a check outside could pass, the employee be deactivated a moment later,
     * and the lead — with every pending follow-up on it — land on an account nobody
     * works. See the lock protocol on resolveFollowUpAssigneeTx.
     */
    if (assignedTo !== null) {
      const owner = await lockAssignableEmployeeTx(connection, assignedTo);
      if (!owner) throw badRequest('The chosen employee does not exist.');
      if (!owner.assignable) {
        throw badRequest('That employee is deactivated and cannot take leads.');
      }
    }

    const [current] = await lockLeadsForUpdateTx(connection, [id]);
    if (!current) throw notFound('Lead not found.');

    // Not an error — a bulk operation may legitimately include a lead that is already
    // where it should be — but nothing to record either.
    if (current.assignedTo === assignedTo) return undefined;

    await reassignLeadInTx(
      connection,
      {
        ...current,
        // The name read before the lock is only good if the owner has not changed since.
        assignedToName: current.assignedTo === before.assignedTo ? before.assignedToName : undefined,
      },
      assignedTo,
      reason,
      actor,
    );

    return current.assignedTo;
  });

  if (previousOwnerId === undefined) return before;

  const after = await findLead(id, null);
  if (!after) throw notFound('Lead not found.');

  await recordAudit({
    actor,
    action: assignedTo === null ? 'lead_unassigned' : 'lead_assigned',
    entityType: 'lead',
    entityId: id,
    summary: `Lead ${after.reference} assigned to ${after.assignedToName ?? 'nobody'}`,
    meta: { from: previousOwnerId, to: assignedTo, reason },
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

  /*
   * A note may say which call it is about — but only a call in this lead's own history.
   *
   * `lead_notes.call_id` has no foreign key (the table predates `calls`), so nothing else
   * stops a note on one lead naming a call on another. The Lead View files a note under
   * the call it names; one that pointed elsewhere would either vanish from this lead's
   * call history or, read the other way, put this customer's words under a stranger's
   * call. One message for "no such call" and "someone else's call", so the refusal tells
   * a caller nothing about calls outside the lead they already hold.
   */
  if (input.callId !== undefined && input.callId !== null) {
    const call = await findCall(input.callId, null);
    if (!call || call.leadId !== leadId) {
      const message = "That call is not part of this lead's history.";
      throw badRequest(message, { callId: message });
    }
  }

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
/* The admin lead list                                                         */
/* -------------------------------------------------------------------------- */

/** A row of the admin lead list: the lead, plus the newest thing written about it. */
export type LeadListItem = LeadRecord & { latestNote: LatestLeadNote | null };

/**
 * The admin lead list, each row carrying its latest note.
 *
 * `listLeads` itself is untouched — the mobile app shares it, and a telecaller's list has
 * no notes column — so the notes are one more query, for the page's ids only, joined on
 * here. Items, totals, ordering and filters are exactly `listLeads`'.
 *
 * A lead nobody has written a note on shows its summary note instead, which is where the
 * admin create form puts "Requirement / notes": an empty cell beside a lead whose
 * requirement is sitting in its record would read as "nothing known".
 */
export async function listLeadsWithLatestNotes(
  filters: LeadListQuery,
  scope: OwnershipScope,
): Promise<Paginated<LeadListItem>> {
  const page = await listLeads(filters, scope);
  const latest = await listLatestLeadNotes(page.items.map((lead) => lead.id));

  return {
    ...page,
    items: page.items.map((lead) => ({
      ...lead,
      latestNote: latest.get(lead.id) ?? summaryAsLatestNote(lead.summaryNote),
    })),
  };
}

/**
 * A lead's summary note in the latest-note shape.
 *
 * Cut by code point (`Array.from`), not by `.slice`, because the SQL path cuts with
 * `LEFT()`, which counts characters: a UTF-16 slice would split an emoji in half and
 * disagree with the database about whether an Indic-script note was truncated.
 */
function summaryAsLatestNote(summary: string | null): LatestLeadNote | null {
  if (summary === null || summary.trim() === '') return null;

  const characters = Array.from(summary);
  return {
    source: 'summary',
    noteId: null,
    kind: null,
    body: characters.slice(0, LATEST_NOTE_PREVIEW_LENGTH).join(''),
    truncated: characters.length > LATEST_NOTE_PREVIEW_LENGTH,
    userName: null,
    callId: null,
    createdAt: null,
  };
}

/* -------------------------------------------------------------------------- */
/* The admin Lead View                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The most pending follow-ups the Lead View returns.
 *
 * A guard, not a page: open work on one lead is a handful, and the screen shows it
 * whole. `counts.pendingFollowUps` is the true number, so a lead that ever passes this
 * says so instead of hiding the rest.
 */
export const LEAD_VIEW_PENDING_FOLLOW_UP_CAP = 100;

/** One call in a lead's history, with everything that was recorded against it. */
export type CallHistoryEntry = CallRecord & {
  /** Notes written against this call, oldest first. */
  notes: LeadNoteRecord[];
  /** Follow-ups booked on this call, newest due first. */
  followUps: FollowUpRecord[];
  statusChange: CallStatusChange | null;
};

/**
 * What the signed-in employee may do from the Lead View, from the same ranks the routes
 * behind each action require — so a button the screen offers is one the API will honour.
 */
export type LeadViewer = {
  role: EmployeeRole;
  canPlayRecordings: boolean;
  canArchive: boolean;
  canDelete: boolean;
};

/**
 * The Lead View's opening response: the lead, and the FIRST page of each of its
 * histories. Further pages come from the history endpoints, one card at a time — a lead
 * with years of calls opens as fast as a new one.
 */
export type LeadView = {
  lead: LeadDetailRecord;
  viewer: LeadViewer;
  /** Over every call on the lead, not the page. */
  callSummary: LeadCallSummary;
  counts: LeadHistoryCounts;
  calls: Paginated<CallHistoryEntry>;
  notes: Paginated<LeadNoteRecord>;
  followUps: {
    /** Every open follow-up, soonest first, up to LEAD_VIEW_PENDING_FOLLOW_UP_CAP. */
    pending: FollowUpRecord[];
    /** Completed and cancelled, newest first. */
    closed: Paginated<FollowUpRecord>;
  };
  timeline: Paginated<ActivityRecord>;
};

export async function getLeadView(id: number, actor: Actor): Promise<LeadView> {
  const lead = await findLeadDetail(id, ownershipScope(actor));
  if (!lead) throw notFound('Lead not found.');

  /*
   * Seven reads at once, one connection each — the histories are independent, and the
   * screen waits for all of them. The pool queues anything over its limit rather than
   * failing, so a burst costs latency, not errors.
   */
  const [callPage, callSummary, notes, pending, closed, timeline, counts] = await Promise.all([
    listLeadCallsPage(id, 1, LEAD_VIEW_PAGE_SIZE),
    leadCallSummary(id),
    listLeadNotesPage(id, 1, LEAD_VIEW_PAGE_SIZE),
    listLeadPendingFollowUps(id, LEAD_VIEW_PENDING_FOLLOW_UP_CAP),
    listLeadClosedFollowUpsPage(id, 1, LEAD_VIEW_PAGE_SIZE),
    listLeadActivityPage(id, 1, LEAD_VIEW_PAGE_SIZE),
    countLeadHistory(id),
  ]);

  return {
    lead,
    viewer: leadViewerFor(actor),
    callSummary,
    counts,
    calls: { ...callPage, items: await withCallContext(id, callPage.items) },
    notes,
    followUps: { pending, closed },
    timeline,
  };
}

/** One page of the lead's calls, newest first, each with its notes, follow-ups and status change. */
export async function listLeadCallHistory(
  id: number,
  page: number,
  pageSize: number,
  actor: Actor,
): Promise<Paginated<CallHistoryEntry>> {
  await assertCanReadLead(id, actor);
  const callPage = await listLeadCallsPage(id, page, pageSize);
  return { ...callPage, items: await withCallContext(id, callPage.items) };
}

/** One page of the lead's notes, newest first, every kind. */
export async function listLeadNoteHistory(
  id: number,
  page: number,
  pageSize: number,
  actor: Actor,
): Promise<Paginated<LeadNoteRecord>> {
  await assertCanReadLead(id, actor);
  return listLeadNotesPage(id, page, pageSize);
}

/** One page of the lead's completed and cancelled follow-ups, newest first. */
export async function listLeadClosedFollowUps(
  id: number,
  page: number,
  pageSize: number,
  actor: Actor,
): Promise<Paginated<FollowUpRecord>> {
  await assertCanReadLead(id, actor);
  return listLeadClosedFollowUpsPage(id, page, pageSize);
}

/** One page of the lead's timeline, newest first. */
export async function listLeadActivityHistory(
  id: number,
  page: number,
  pageSize: number,
  actor: Actor,
): Promise<Paginated<ActivityRecord>> {
  await assertCanReadLead(id, actor);
  return listLeadActivityPage(id, page, pageSize);
}

function leadViewerFor(actor: Actor): LeadViewer {
  return {
    role: actor.role,
    // GET /recordings/:id/audio and POST /leads/:id/archive are manager and above;
    // DELETE /leads/:id is admin only.
    canPlayRecordings: hasRole(actor, 'manager'),
    canArchive: hasRole(actor, 'manager'),
    canDelete: hasRole(actor, 'admin'),
  };
}

/**
 * 404 unless the lead exists and the actor may see it — before any of its history is
 * read. The same rule as `findLead`'s ownership filter and as `assertCanWriteLead`; a
 * 404 rather than a 403 for the reason given there.
 */
async function assertCanReadLead(id: number, actor: Actor): Promise<void> {
  const lead = await findLeadOwner(id);
  if (!lead || !canActOnOwner(actor, lead.assignedTo)) throw notFound('Lead not found.');
}

/**
 * Pairs a page of calls with what was recorded against each: notes, the follow-ups
 * booked on it, and the status it set. Three queries for the whole page — never one per
 * call — and none for an empty page.
 */
async function withCallContext(leadId: number, calls: CallRecord[]): Promise<CallHistoryEntry[]> {
  if (calls.length === 0) return [];

  const ids = calls.map((call) => call.id);
  const [notes, followUps, statusChanges] = await Promise.all([
    listLeadCallNotes(leadId, ids),
    listCallFollowUps(leadId, ids),
    listCallStatusChanges(leadId, ids),
  ]);

  return calls.map((call) => ({
    ...call,
    notes: notes.get(call.id) ?? [],
    followUps: followUps.get(call.id) ?? [],
    statusChange: statusChanges.get(call.id) ?? null,
  }));
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
