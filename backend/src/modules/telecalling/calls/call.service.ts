import type { PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../../../db/pool';
import { badRequest, notFound } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { canActOnOwner, hasRole, ownershipScope, type Actor, type OwnershipScope } from '../actor';
import { recordActivityTx } from '../activity/activity.repository';
import { formatCompanyDateTime } from '../companyTime';
import { companyPhoneHolder, findEmployeeCompanyLine } from '../employees/employee.repository';
import {
  findFollowUpForCall,
  findPendingFollowUpForCallTx,
  insertFollowUpTx,
  rescheduleFollowUpTx,
  type FollowUpRecord,
} from '../followups/followUp.repository';
import {
  followUpScheduledSummary,
  resolveFollowUpAssigneeTx,
} from '../followups/followUp.service';
import {
  findLeadOwner,
  findLeadOwnerTx,
  findLeadsByPhone,
  findNoteByClientUuid,
  insertNoteTx,
  refreshLeadCachesTx,
  updateLeadStatusTx,
  type LeadNoteRecord,
} from '../leads/lead.repository';
import { queueNotification } from '../notifications/notification.repository';
import {
  companyPhoneKey,
  UNANSWERED_OUTCOMES,
  type CallIgnoreReason,
  type CallOutcome,
  type DeviceSimMatch,
  type LeadStatus,
} from '../shared.schema';
import {
  countMyCalls,
  findCall,
  findCallByClientUuid,
  findCallIdByRecordClientUuid,
  findOwnCall,
  insertCallTx,
  listCallNoteSummaries,
  listCallNotes,
  listCalls,
  listMyCalls,
  lockCallForWriteUpTx,
  markIncomingLineVerified,
  recordCallTx,
  resolveEarlierMissedCallsTx,
  type CallListResult,
  type CallNoteSummary,
  type CallRecord,
  type MyCallCounts,
  type OwnCallRecord,
} from './call.repository';
import {
  callClientUuidParam,
  type CallLineInput,
  type CallListQuery,
  type LogCallInput,
  type MyCallListQuery,
  type RecordCallInput,
} from './call.schema';

/**
 * Call logging.
 *
 * The whole point of this service is that one request from the phone produces one
 * atomic change: the call row, the note, the lead status, the follow-up, the cache
 * refresh and every activity row. Splitting them into separate requests is what
 * produces a lead marked `follow_up` with no follow-up attached, or a call logged
 * against a status that never changed — and a telecaller who sees that once stops
 * trusting the app and starts keeping a paper list.
 */

/* -------------------------------------------------------------------------- */
/* The company line                                                            */
/* -------------------------------------------------------------------------- */

/** Whether an incoming call can be stored as received on the employee's company SIM. */
export type LineVerdict =
  | { ok: true; receivedOnPhone: string; simMatch: DeviceSimMatch }
  | { ok: false; reason: CallIgnoreReason; holderId?: number };

/**
 * Checks a handset's line evidence against the company number the SERVER holds.
 *
 * The device session is not trusted to say "this was a work call". The company number is
 * server-owned — entered at signup, checked by an admin at approval, unique among live
 * staff — and is read fresh here on every upload, so a number an admin corrects takes
 * effect on the next call rather than when a token expires. The handset only says which
 * local SIM it matched to that number; what is stored as `received_on_phone` comes from
 * the database, never from the request.
 *
 * In order, the reasons a call is set aside:
 *
 *   no_company_number    nothing to verify against yet — the employee has no number on file
 *   line_unverified      no usable evidence: a build from before the check, or a malformed one
 *   stale_confirmation   the handset chose its SIM against a number that has since changed
 *   other_employee_line  the SIM that took the call is a colleague's company number. Logged,
 *                        and NOT stored against the colleague either: the session user
 *                        is the only person a call can be attributed to, and a shared
 *                        handset is not a reason to bend that.
 *   not_company_line     the SIM's own number is readable and is not the company one
 */
export async function verifyCompanyLine(
  line: CallLineInput | null,
  actorId: number,
): Promise<LineVerdict> {
  const registered = await findEmployeeCompanyLine(actorId);
  if (!registered?.companyPhone || !registered.companyPhoneKey) {
    return { ok: false, reason: 'no_company_number' };
  }

  if (!line) return { ok: false, reason: 'line_unverified' };

  if (line.confirmedFor !== registered.companyPhoneKey) {
    return { ok: false, reason: 'stale_confirmation' };
  }

  if (line.simNumber !== null) {
    const simKey = companyPhoneKey(line.simNumber);
    if (simKey !== registered.companyPhoneKey) {
      const holder = simKey ? await companyPhoneHolder(simKey, actorId) : null;
      return holder
        ? { ok: false, reason: 'other_employee_line', holderId: holder.id }
        : { ok: false, reason: 'not_company_line' };
    }
  }

  return { ok: true, receivedOnPhone: registered.companyPhone, simMatch: line.match };
}

/* -------------------------------------------------------------------------- */
/* Logging a call                                                              */
/* -------------------------------------------------------------------------- */

export type LogCallResult = {
  /**
   * The call as stored. Null when the call was set aside (`ignored`), and on a replay of
   * an id that belongs to another employee's call — whose details are not this
   * employee's to see.
   */
  call: CallRecord | null;
  followUpId: number | null;
  /** True when this was a retry of a request that had already been applied. */
  deduplicated: boolean;
  /**
   * True when the call was deliberately not stored: an incoming call that could not be
   * verified as received on the company SIM. Always answered 200 — never a 4xx, which
   * older app builds treat as a permanent failure and announce as lost work.
   */
  ignored: boolean;
  reason: CallIgnoreReason | null;
};

export async function logCall(
  input: LogCallInput,
  actor: Actor,
): Promise<LogCallResult> {
  /**
   * Offline-queue retry.
   *
   * Checked before anything else and returned as a success, not an error. The client
   * cannot tell a lost response from a lost request, so it retries; answering "already
   * done, here it is" is the only response that lets the queue drain.
   */
  if (input.clientUuid) {
    const existing = await findCallByClientUuid(input.clientUuid);
    if (existing) return replayOfLoggedCall(existing, input, actor);
  }

  /**
   * An incoming call is stored only when it is verified as received on the company SIM.
   *
   * Checked for EVERY incoming call, whatever its `source` or `channel` claims — neither
   * field may be a way round it — and before the number is matched to a lead, so a
   * personal call never touches a customer's record. Everything set aside is answered
   * 200 with the reason, never a 4xx (see `LogCallResult.ignored`). Nothing is written
   * and nothing is notified, and the log line carries no phone number.
   */
  let verdict: LineVerdict | null = null;
  if (input.direction === 'incoming') {
    verdict = await verifyCompanyLine(input.line, actor.id);
    if (!verdict.ok) {
      logger.info('Incoming call set aside: not verified as received on the company line', {
        userId: actor.id,
        reason: verdict.reason,
        ...(verdict.holderId !== undefined ? { holderId: verdict.holderId } : {}),
      });
      return {
        call: null,
        followUpId: null,
        deduplicated: false,
        ignored: true,
        reason: verdict.reason,
      };
    }
  }

  /**
   * Resolve the lead.
   *
   * When the client names one, it is used — subject to ownership. When it does not (an
   * incoming call from a number the telecaller did not recognise), the number is matched
   * against their leads. A match is only accepted when it is unambiguous: two leads
   * sharing a number is a real situation, and attaching the call to the wrong one is
   * worse than attaching it to none, because it puts a conversation in a stranger's
   * history.
   */
  let leadId: number | null = null;
  // Who owns that lead — the default holder of a follow-up booked on this call.
  let leadOwner: number | null = null;

  if (input.leadId) {
    const lead = await findLeadOwner(input.leadId);
    if (!lead) throw notFound('Lead not found.');
    if (!canActOnOwner(actor, lead.assignedTo)) throw notFound('Lead not found.');
    leadId = lead.id;
    leadOwner = lead.assignedTo;
  } else {
    const matches = await findLeadsByPhone(input.phone, actor.id);
    if (matches.length === 1) {
      leadId = matches[0]!.id;
      leadOwner = matches[0]!.assignedTo;
    } else if (matches.length > 1) {
      logger.debug('Call not attached: several leads share this number', {
        phone: input.phone.slice(-4),
        matches: matches.length,
      });
    }
  }

  if (input.leadStatus && leadId === null) {
    throw badRequest('A lead status can only be set on a call that belongs to a lead.');
  }

  if (input.followUpAt && leadId === null) {
    throw badRequest('A follow-up can only be scheduled against a lead.');
  }

  /**
   * A duration on an unanswered call is meaningless and is discarded.
   *
   * The Android call-log reader can match a ringing entry and report a few seconds of
   * ring time as duration. Left in, that inflates every talk-time average with time
   * nobody spent talking.
   */
  const durationSeconds = UNANSWERED_OUTCOMES.includes(input.outcome) ? 0 : input.durationSeconds;

  const answered = input.outcome === 'answered';

  const { callId, followUpId } = await withTransaction(async (connection) => {
    const id = await insertCallTx(connection, {
      clientUuid: input.clientUuid,
      leadId,
      userId: actor.id,
      phone: input.phone,
      direction: input.direction,
      outcome: input.outcome,
      channel: input.channel,
      source: input.source,
      durationSeconds,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      providerCallSid: null,
      // Stamped from the employee row by verifyCompanyLine, never from the request.
      receivedOnPhone: verdict?.ok ? verdict.receivedOnPhone : null,
      simMatch: verdict?.ok ? verdict.simMatch : null,
    });

    let createdFollowUpId: number | null = null;

    if (leadId !== null) {
      /*
       * Who will hold a follow-up booked on this call — resolved FIRST, under the
       * assignee's share lock, so this transaction takes employee rows before it touches
       * the lead row (the lock order documented on resolveFollowUpAssigneeTx).
       */
      const assignee = input.followUpAt
        ? await resolveFollowUpAssigneeTx(connection, { actor, leadOwner })
        : null;

      await recordActivityTx(connection, {
        leadId,
        userId: actor.id,
        type: 'call_logged',
        summary: describeCall(actor.name, input.direction, input.outcome, durationSeconds),
        meta: {
          callId: id,
          direction: input.direction,
          outcome: input.outcome,
          durationSeconds,
          channel: input.channel,
          source: input.source,
        },
      });

      if (input.note) {
        await insertNoteTx(connection, {
          leadId,
          userId: actor.id,
          kind: 'call_note',
          body: input.note,
          callId: id,
          // The call already carries the idempotency key; reusing it here would violate
          // the unique index on lead_notes.client_uuid on a legitimate retry.
          clientUuid: null,
        });
        await recordActivityTx(connection, {
          leadId,
          userId: actor.id,
          type: 'note_added',
          summary: `${actor.name} added a note after the call`,
          meta: { callId: id },
        });
      }

      if (input.leadStatus) {
        await applyStatusFromCallTx(connection, leadId, input.leadStatus, id, actor);
      }

      if (input.followUpAt) {
        /*
         * Linked to the call it was booked on, so the call's own history can show it and
         * a later write-up of the call moves it instead of booking a second one.
         */
        createdFollowUpId = await insertFollowUpTx(connection, {
          leadId,
          assignedTo: assignee,
          createdBy: actor.id,
          dueAt: input.followUpAt,
          note: input.followUpNote,
          // The call row carries this request's idempotency key.
          clientUuid: null,
          callId: id,
        });

        await recordActivityTx(connection, {
          leadId,
          userId: actor.id,
          type: 'follow_up_created',
          summary: followUpScheduledSummary(actor.name, assignee),
          meta: {
            dueAt: input.followUpAt.toISOString(),
            followUpId: createdFollowUpId,
            callId: id,
            assignedTo: assignee,
          },
        });
      }
    }

    // A connected call clears the callback queue for earlier failed attempts to the same
    // number — the conversation those were waiting for has now happened.
    if (answered) {
      await resolveEarlierMissedCallsTx(connection, actor.id, leadId, input.phone, input.startedAt);
    }

    if (leadId !== null) {
      await refreshLeadCachesTx(connection, leadId);
    }

    return { callId: id, followUpId: createdFollowUpId };
  });

  const call = await findCall(callId, null);
  if (!call) throw notFound('Call not found after logging.');

  /**
   * An incoming call the telecaller did not take is worth a notification even though
   * they were holding the phone: it may have arrived while they were on another call,
   * and it is the one event in this system that has a customer waiting at the other end.
   *
   * Only ever for a verified call — one that reached this point — so a missed call on the
   * employee's personal SIM never comes back to them as a work alert.
   */
  if (input.direction === 'incoming' && input.outcome === 'missed') {
    await queueNotification({
      userId: actor.id,
      kind: 'missed_call',
      title: 'Missed call',
      body: call.leadName ? `${call.leadName} — ${call.phone}` : call.phone,
      leadId,
    });
  }

  return { call, followUpId, deduplicated: false, ignored: false, reason: null };
}

/**
 * The answer to a call whose client id has been seen before.
 *
 * Three cases. Another employee's call (two handsets deriving the same id from the same
 * number and second, or a forged id) is acknowledged as already stored and nothing more —
 * its details are not this employee's, and it must not be re-attributed. The employee's
 * own LEGACY incoming row, saved unverified before the company-SIM check, is upgraded
 * when this replay carries evidence that verifies: that is how a current build's
 * re-scan of the call log recovers the company calls among the old uploads, without a
 * second row for one physical call. Anything else is the ordinary retry.
 */
async function replayOfLoggedCall(
  existing: CallRecord,
  input: LogCallInput,
  actor: Actor,
): Promise<LogCallResult> {
  const replay = { followUpId: null, deduplicated: true, ignored: false, reason: null };

  if (existing.userId !== actor.id) return { ...replay, call: null };

  if (existing.direction === 'incoming' && existing.simMatch === null && input.direction === 'incoming') {
    const verdict = await verifyCompanyLine(input.line, actor.id);
    if (verdict.ok) {
      await markIncomingLineVerified(existing.id, actor.id, {
        receivedOnPhone: verdict.receivedOnPhone,
        simMatch: verdict.simMatch,
      });
      return { ...replay, call: (await findCall(existing.id, null)) ?? existing };
    }
  }

  return { ...replay, call: existing };
}

/**
 * Applies the status chosen on a call to its lead, with the timeline line naming the call.
 * A no-op when the lead already has that status.
 */
async function applyStatusFromCallTx(
  connection: PoolConnection,
  leadId: number,
  status: LeadStatus,
  callId: number,
  actor: Actor,
): Promise<void> {
  const before = await findLeadOwnerTx(connection, leadId);
  if (!before || before.status === status) return;

  await updateLeadStatusTx(connection, leadId, status);
  await recordActivityTx(connection, {
    leadId,
    userId: actor.id,
    type: 'status_changed',
    summary: `${actor.name} changed the status from ${before.status.replace(/_/g, ' ')} to ${status.replace(/_/g, ' ')}`,
    meta: { from: before.status, to: status, callId },
  });
}

function describeCall(
  actorName: string,
  direction: string,
  outcome: CallOutcome,
  durationSeconds: number,
): string {
  const verb = direction === 'incoming' ? 'received a call' : 'called';

  if (outcome === 'answered') {
    return `${actorName} ${verb} — connected for ${formatDuration(durationSeconds)}`;
  }

  return `${actorName} ${verb} — ${outcome.replace(/_/g, ' ')}`;
}

/** Human-readable duration for a timeline line. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export type BatchResult = {
  accepted: number;
  duplicates: number;
  /** Incoming calls set aside because their line could not be verified (see logCall). */
  ignored: number;
  /** Per-call failures, so the client can drop what will never succeed and retry the rest. */
  failures: { index: number; clientUuid: string | null; message: string }[];
};

/**
 * Drains a batch from the offline queue.
 *
 * Each call is applied in its own transaction rather than one transaction for the batch.
 * A single bad entry — a lead deleted while the phone was offline — must not reject the
 * other ninety-nine, and the client needs to know precisely which ones to stop retrying.
 */
export async function logCallBatch(
  inputs: LogCallInput[],
  actor: Actor,
): Promise<BatchResult> {
  const failures: BatchResult['failures'] = [];
  let accepted = 0;
  let duplicates = 0;
  let ignored = 0;

  for (const [index, input] of inputs.entries()) {
    try {
      const result = await logCall(input, actor);
      if (result.ignored) ignored += 1;
      else if (result.deduplicated) duplicates += 1;
      else accepted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not log this call.';
      failures.push({ index, clientUuid: input.clientUuid, message });
      logger.warn('Batch call log rejected an entry', { index, message });
    }
  }

  return { accepted, duplicates, ignored, failures };
}

/* -------------------------------------------------------------------------- */
/* Call lists                                                                  */
/* -------------------------------------------------------------------------- */

/** A row of the admin call list: the call, its newest note, and how many it has. */
export type AdminCallRecord = CallRecord & {
  latestNote: CallNoteSummary | null;
  noteCount: number;
};

/**
 * The admin call list with the Notes column filled in.
 *
 * One extra indexed query for the page's notes — never a join in `listCalls`, which the
 * mobile lists share. Admin only on purpose: a telecaller's own list must not show a note
 * a later owner of a reassigned lead wrote against the call.
 */
export async function listCallsWithNotes(
  filters: CallListQuery,
  scope: OwnershipScope,
): Promise<Omit<CallListResult, 'items'> & { items: AdminCallRecord[] }> {
  const result = await listCalls(filters, scope);
  const notes = await listCallNoteSummaries(result.items.map((call) => call.id));

  return {
    ...result,
    items: result.items.map((call) => {
      const summary = notes.get(call.id);
      return { ...call, latestNote: summary?.latest ?? null, noteCount: summary?.count ?? 0 };
    }),
  };
}

/** The newest note on a call, as My activity's rows show it. */
export type CallNotePreview = {
  id: number;
  kind: CallNoteSummary['kind'];
  body: string;
  userName: string | null;
  createdAt: string;
};

/** A row of My activity's call list. */
export type CallListItem = OwnCallRecord & {
  latestNote: CallNotePreview | null;
  noteCount: number;
};

function toCallListItem(
  call: OwnCallRecord,
  notes: Map<number, { latest: CallNoteSummary; count: number }>,
): CallListItem {
  const summary = notes.get(call.id);
  const latest = summary?.latest ?? null;

  return {
    ...call,
    latestNote: latest
      ? {
          id: latest.id,
          kind: latest.kind,
          body: latest.body,
          userName: latest.authorName,
          createdAt: latest.createdAt,
        }
      : null,
    noteCount: summary?.count ?? 0,
  };
}

export type MyCallsPage = {
  items: CallListItem[];
  /** Pass back as `cursor` for the next page. Null when there is nothing more. */
  nextCursor: string | null;
  /** Only on a first page that asked for it. */
  counts?: MyCallCounts;
};

/**
 * One page of My activity: the employee's OWN calls, newest first, whatever their role.
 *
 * The notes are read for this page's rows only, and the chip counts only on a first page
 * that asks — they do not change while the employee scrolls, and a second aggregate per
 * page would be paid on every "load more".
 */
export async function listMyCallsPage(actor: Actor, filters: MyCallListQuery): Promise<MyCallsPage> {
  const [page, counts] = await Promise.all([
    listMyCalls(actor.id, filters),
    filters.withCounts && !filters.cursor ? countMyCalls(actor.id, filters) : Promise.resolve(null),
  ]);

  const notes = await listCallNoteSummaries(page.items.map((call) => call.id));

  return {
    items: page.items.map((call) => toCallListItem(call, notes)),
    nextCursor: page.nextCursor,
    ...(counts ? { counts } : {}),
  };
}

/** At most this many notes in a call's detail; `notesTotal` says how many there are. */
export const CALL_DETAIL_NOTE_LIMIT = 50;

export type CallDetail = {
  call: CallListItem;
  /** Notes written on the call, newest first — the newest `CALL_DETAIL_NOTE_LIMIT`. */
  notes: LeadNoteRecord[];
  /** How many notes the call has in all, so a capped list says so instead of hiding it. */
  notesTotal: number;
  /** The follow-up booked from this call — the latest, whatever its state. */
  followUp: FollowUpRecord | null;
  /** Leads the number matches, for a call not yet filed against one; empty otherwise. */
  matches: { id: number; reference: string; name: string; status: LeadStatus }[];
};

/**
 * One call in full, in one request — the call detail screen.
 *
 * Under the caller's ownership scope: a telecaller's own calls, or any call for a
 * supervisor. A call the caller may not see is a 404, the same answer as one that does
 * not exist, as for leads. `matches` are looked up under the same scope, so a telecaller
 * is never offered a colleague's customer to file the call against.
 */
export async function getCallDetail(callId: number, actor: Actor): Promise<CallDetail> {
  const scope = ownershipScope(actor);

  const call = await findOwnCall(callId, scope);
  if (!call) throw notFound('Call not found.');

  const [notesByCall, notes, followUp, matches] = await Promise.all([
    listCallNoteSummaries([call.id]),
    listCallNotes(call.id, CALL_DETAIL_NOTE_LIMIT),
    // A call no lead holds has no follow-up of its own: those hang off a lead.
    call.leadId === null ? Promise.resolve(null) : findFollowUpForCall(call.id, call.leadId),
    call.leadId === null ? findLeadsByPhone(call.phone, scope) : Promise.resolve([]),
  ]);

  return {
    call: toCallListItem(call, notesByCall),
    notes,
    notesTotal: notesByCall.get(call.id)?.count ?? 0,
    followUp,
    matches: matches.map((lead) => ({
      id: lead.id,
      reference: lead.reference,
      name: lead.customerName,
      status: lead.status,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Writing up a call that already exists                                       */
/* -------------------------------------------------------------------------- */

export type RecordCallResult = {
  call: CallRecord;
  /** The follow-up this write-up booked or moved; null when it touched none. */
  followUpId: number | null;
  /** True when this write-up (its `clientUuid`) had already been applied — nothing changed. */
  deduplicated: boolean;
};

const WRITE_UP_KEY_REUSED = 'This update was already saved for a different call.';

/**
 * Where a write-up key has already been used, if anywhere: `{ callId }` for a write-up of
 * that call, `{ callId: null }` for a key some other kind of save used, null for unused.
 *
 * Two places remember a key. The call keeps the key of its LATEST write-up
 * (`record_client_uuid`), which is what catches a retry and two deliveries racing. A
 * write-up that adds a note also stores its key on that note, whose `client_uuid` is
 * unique for good — so a note-bearing write-up stays recognisable after a later save has
 * taken the call's slot, and its replay can never post the same note twice.
 */
async function writeUpKeyUse(key: string): Promise<{ callId: number | null } | null> {
  const onCall = await findCallIdByRecordClientUuid(key);
  if (onCall !== null) return { callId: onCall };

  const note = await findNoteByClientUuid(key);
  return note ? { callId: note.callId } : null;
}

/** A unique index refused a write-up key: on the call's slot, or on its note. */
function isWriteUpKeyClash(error: unknown): boolean {
  const driverError = error as { code?: unknown; message?: unknown };
  return (
    driverError?.code === 'ER_DUP_ENTRY' &&
    typeof driverError.message === 'string' &&
    (driverError.message.includes('uq_calls_record_client_uuid') ||
      driverError.message.includes('uq_lead_notes_client_uuid'))
  );
}

/** Whether two due times differ once stored: DATETIME keeps whole seconds, rounding. */
function dueTimesDiffer(stored: string, requested: Date): boolean {
  return Math.round(Date.parse(stored) / 1000) !== Math.round(requested.getTime() / 1000);
}

/**
 * Records what happened on a call the system already knows about.
 *
 * WHY THIS IS NOT `logCall`
 * -------------------------
 * An outgoing call is created and written up in one movement: the telecaller dials, the
 * sheet appears, they fill it in, and `logCall` inserts the whole thing. An incoming
 * call arrives the other way round. It is read out of the handset's call log and saved
 * before anybody has looked at it, so by the time the telecaller has something to say
 * about it the row already exists — and `logCall` would either refuse it as a duplicate
 * (the client id is derived from the log row, so it is stable) or, worse, insert a
 * second row for the same physical call. The same holds for a call saved with no
 * remarks and written up later from My activity.
 *
 * So this fills in the parts only a person can supply — which customer it was, what was
 * said, what to do next — against a row that is already there. There is exactly one row
 * per physical call, before and after, which is what makes duplicate call records
 * impossible rather than merely unlikely.
 *
 * SAVING TWICE
 * ------------
 * The offline queue retries a write-up it could not confirm, and the employee can save
 * one call more than once. Neither may duplicate anything:
 *
 *   - A retry carries the same `clientUuid` and applies nothing the second time. It is
 *     answered before any re-validation, and re-checked under a row lock on the call, so
 *     two deliveries racing each other still apply once. (The call remembers only its
 *     latest write-up's key; a write-up with a note is also remembered by its note — see
 *     `writeUpKeyUse`. The offline queue is first-in, first-out, so a retry is always
 *     sent before the next save of the same call.)
 *   - A genuine second save carries a new key. Its note is appended — a note is what
 *     someone believed at a point in time, and notes are never edited — but its
 *     follow-up MOVES the pending one booked on this call instead of adding another,
 *     and "call logged" is written only when the call first joins a lead's history.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Move a call between leads. `leadId` is honoured only when the call has none, so
 * writing up a call cannot take a conversation out of one customer's history and put it
 * in another's. Correcting a mis-attached call is a different operation and deliberately
 * not this one.
 */
export async function recordCall(
  callId: number,
  input: RecordCallInput,
  actor: Actor,
): Promise<RecordCallResult> {
  const existing = await findCall(callId, ownershipScope(actor));
  if (!existing) throw notFound('Call not found.');

  /*
   * A write-up already applied is acknowledged before anything is re-validated: the lead
   * it named may have changed hands since, and "already saved" is still the truth. A key
   * already used for anything else — another call's write-up, some other save — is a
   * client fault, refused rather than guessed at.
   */
  if (input.clientUuid) {
    const used = await writeUpKeyUse(input.clientUuid);
    if (used && used.callId === callId) return { call: existing, followUpId: null, deduplicated: true };
    if (used) throw badRequest(WRITE_UP_KEY_REUSED);
  }

  /*
   * Which lead this call belongs to, in order of authority: the one it already has, the
   * one the telecaller picked, then the one its number matches.
   *
   * The phone fallback is what makes the common case one tap. An incoming call from a
   * number that matches exactly one lead should not ask which customer it was — the
   * server already knows, and `logCall` answers the same question the same way. It
   * matches among the leads of the employee whose call it is, which for a supervisor
   * writing up a telecaller's call is the telecaller, not the supervisor.
   */
  let leadId: number | null = existing.leadId;

  if (leadId === null && input.leadId) {
    const lead = await findLeadOwner(input.leadId);
    if (!lead) throw notFound('Lead not found.');
    if (!canActOnOwner(actor, lead.assignedTo)) throw notFound('Lead not found.');
    leadId = lead.id;
  }

  if (leadId === null) {
    const matches = await findLeadsByPhone(existing.phone, existing.userId);
    if (matches.length === 1) leadId = matches[0]!.id;
  }

  /*
   * A note, a status or a follow-up with nobody to attach it to.
   *
   * Refused rather than silently dropped: all three live on the lead, and a telecaller
   * who typed a paragraph about the conversation must not be told it was saved when it
   * went nowhere. The app keeps these disabled until a lead is chosen, so reaching this
   * means the client got ahead of itself.
   */
  if (leadId === null && (input.note || input.leadStatus || input.followUpAt)) {
    throw badRequest(
      'Choose a lead, or create one, before saving notes or a follow-up against this call.',
    );
  }

  const outcome = input.outcome ?? existing.outcome;

  /*
   * Same rule as logging a fresh call: a duration on a call that never connected is
   * ring time, and counting it inflates every talk-time average.
   */
  const durationSeconds = UNANSWERED_OUTCOMES.includes(outcome)
    ? 0
    : (input.durationSeconds ?? existing.durationSeconds);

  let applied: { followUpId: number | null } | null;

  try {
    applied = await withTransaction(async (connection) => {
      const locked = await lockCallForWriteUpTx(connection, callId);
      if (!locked) throw notFound('Call not found.');

      // The same write-up delivered twice at once: this one waited on the lock above,
      // and the first has already applied it.
      if (input.clientUuid && locked.recordClientUuid === input.clientUuid) return null;

      /*
       * The lead as committed, not as read before the lock: if another save linked the
       * call meanwhile, that link stands (a call is never re-pointed), and only the save
       * that actually links it writes the "call logged" line.
       */
      const effectiveLeadId = locked.leadId ?? leadId;
      const joinsLead = locked.leadId === null && effectiveLeadId !== null;
      const booksFollowUp = input.followUpAt !== null && effectiveLeadId !== null;

      /*
       * Who will hold a newly booked follow-up — the lead's CURRENT owner by default, read
       * now rather than assumed to be the actor: the call may have joined its lead long
       * before this write-up, and the lead may have changed hands since. Resolved before
       * the lead row is touched, under the assignee's share lock (the lock order on
       * resolveFollowUpAssigneeTx). A follow-up that is only moved keeps its holder.
       */
      const assignee =
        booksFollowUp && effectiveLeadId !== null
          ? await resolveFollowUpAssigneeTx(connection, {
              actor,
              leadOwner: (await findLeadOwnerTx(connection, effectiveLeadId))?.assignedTo ?? null,
            })
          : null;

      await recordCallTx(connection, callId, locked.userId, {
        leadId: effectiveLeadId,
        outcome,
        durationSeconds,
        followUpBooked: booksFollowUp,
        recordClientUuid: input.clientUuid,
      });

      if (effectiveLeadId === null) return { followUpId: null };

      /*
       * The timeline line for the call itself, written only when this write-up is what
       * brings the call into the lead's history: a call that matched a lead on the way in
       * was logged by `logCall` then, and one adopted by a new lead was summarised by
       * `createLead`. Writing it on every save put one call on the timeline once per
       * save, and made the history look busier than the work was.
       */
      if (joinsLead) {
        await recordActivityTx(connection, {
          leadId: effectiveLeadId,
          userId: actor.id,
          type: 'call_logged',
          summary: describeCall(actor.name, locked.direction, outcome, durationSeconds),
          meta: {
            callId,
            direction: locked.direction,
            outcome,
            durationSeconds,
            recordedFrom: 'write_up',
          },
        });
      }

      if (input.note) {
        await insertNoteTx(connection, {
          leadId: effectiveLeadId,
          userId: actor.id,
          kind: 'call_note',
          body: input.note,
          callId,
          // The write-up's own key (never the CALL's, which `logCall` already holds), so
          // this note is recognised as this write-up's for good — see writeUpKeyUse.
          clientUuid: input.clientUuid,
        });

        await recordActivityTx(connection, {
          leadId: effectiveLeadId,
          userId: actor.id,
          type: 'note_added',
          summary: `${actor.name} wrote up this call`,
          meta: { callId },
        });
      }

      if (input.leadStatus) {
        await applyStatusFromCallTx(connection, effectiveLeadId, input.leadStatus, callId, actor);
      }

      let followUpId: number | null = null;

      if (input.followUpAt) {
        /*
         * One pending follow-up per call. A second save finds the one booked before —
         * locked, so two saves cannot both decide there is none — and moves it if the
         * time changed, rather than leaving the employee two reminders for one promise.
         * An unchanged time leaves it exactly as it was.
         */
        const pending = await findPendingFollowUpForCallTx(connection, callId, effectiveLeadId);

        if (pending) {
          followUpId = pending.id;

          if (dueTimesDiffer(pending.dueAt, input.followUpAt)) {
            const moved = await rescheduleFollowUpTx(
              connection,
              pending.id,
              input.followUpAt,
              input.followUpNote,
            );

            if (moved) {
              await recordActivityTx(connection, {
                leadId: effectiveLeadId,
                userId: actor.id,
                type: 'follow_up_rescheduled',
                summary: `${actor.name} moved a follow-up from ${formatCompanyDateTime(pending.dueAt)} to ${formatCompanyDateTime(input.followUpAt)}`,
                meta: {
                  followUpId: pending.id,
                  from: pending.dueAt,
                  to: input.followUpAt.toISOString(),
                  callId,
                },
              });
            }
          }
        } else {
          followUpId = await insertFollowUpTx(connection, {
            leadId: effectiveLeadId,
            assignedTo: assignee,
            createdBy: actor.id,
            dueAt: input.followUpAt,
            note: input.followUpNote,
            clientUuid: null,
            callId,
          });

          await recordActivityTx(connection, {
            leadId: effectiveLeadId,
            userId: actor.id,
            type: 'follow_up_created',
            summary: followUpScheduledSummary(actor.name, assignee),
            meta: {
              dueAt: input.followUpAt.toISOString(),
              followUpId,
              callId,
              assignedTo: assignee,
            },
          });
        }
      }

      /*
       * Attaching a call to a lead changes when that lead was last contacted, and the
       * dashboard's "not yet called" tile reads that column. Without this the lead would
       * keep claiming nobody had ever spoken to it.
       */
      await refreshLeadCachesTx(connection, effectiveLeadId);

      return { followUpId };
    });
  } catch (error) {
    if (!input.clientUuid || !isWriteUpKeyClash(error)) throw error;

    /*
     * A unique index caught a key the checks above did not see — the same key arriving
     * twice at the same instant. Nothing of this attempt was kept (the transaction rolled
     * back), so the answer depends on where the key landed: on this call it is a replay,
     * anywhere else a reused key.
     */
    const used = await writeUpKeyUse(input.clientUuid);
    if (used?.callId !== callId) throw badRequest(WRITE_UP_KEY_REUSED);
    applied = null;
  }

  const call = await findCall(callId, null);
  if (!call) throw notFound('Call not found after recording.');

  return applied === null
    ? { call, followUpId: null, deduplicated: true }
    : { call, followUpId: applied.followUpId, deduplicated: false };
}

/**
 * The same write-up, addressed by the CALL's client id rather than its server id.
 *
 * For a call whose server id the handset does not know yet — saved while offline and
 * written up before the queue had sent it. The queue is first-in, first-out, so the call
 * itself always reaches the server before its write-up does.
 *
 * The caller's own call, or any call for a supervisor and above. Anything else — another
 * employee's call, an id never seen, a value that is not a UUID — is a 404, the same
 * answer for all three, so the endpoint cannot be used to probe for calls.
 */
export async function recordCallByClientUuid(
  callClientUuid: string | undefined,
  input: RecordCallInput,
  actor: Actor,
): Promise<RecordCallResult> {
  const parsed = callClientUuidParam.safeParse(callClientUuid);
  if (!parsed.success) throw notFound('Call not found.');

  const call = await findCallByClientUuid(parsed.data);
  if (!call || (call.userId !== actor.id && !hasRole(actor, 'supervisor'))) {
    throw notFound('Call not found.');
  }

  return recordCall(call.id, input, actor);
}
