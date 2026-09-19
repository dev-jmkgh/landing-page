import { withTransaction } from '../../../db/pool';
import { badRequest, notFound } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { canActOnOwner, ownershipScope, type Actor } from '../actor';
import { recordActivityTx } from '../activity/activity.repository';
import {
  findLeadOwner,
  findLeadsByPhone,
  insertNoteTx,
  refreshLeadCachesTx,
  updateLeadStatusTx,
} from '../leads/lead.repository';
import { queueNotification } from '../notifications/notification.repository';
import { UNANSWERED_OUTCOMES, type CallOutcome } from '../shared.schema';
import {
  findCall,
  findCallByClientUuid,
  recordCallTx,
  insertCallTx,
  resolveEarlierMissedCallsTx,
  type CallRecord,
} from './call.repository';
import type { LogCallInput, RecordCallInput } from './call.schema';

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

export type LogCallResult = {
  call: CallRecord;
  followUpId: number | null;
  /** True when this was a retry of a request that had already been applied. */
  deduplicated: boolean;
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
    if (existing) return { call: existing, followUpId: null, deduplicated: true };
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

  if (input.leadId) {
    const lead = await findLeadOwner(input.leadId);
    if (!lead) throw notFound('Lead not found.');
    if (!canActOnOwner(actor, lead.assignedTo)) throw notFound('Lead not found.');
    leadId = lead.id;
  } else {
    const matches = await findLeadsByPhone(input.phone, actor.id);
    if (matches.length === 1) {
      leadId = matches[0]!.id;
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
    });

    let createdFollowUpId: number | null = null;

    if (leadId !== null) {
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
        const before = await findLeadOwner(leadId);
        if (before && before.status !== input.leadStatus) {
          await updateLeadStatusTx(connection, leadId, input.leadStatus);
          await recordActivityTx(connection, {
            leadId,
            userId: actor.id,
            type: 'status_changed',
            summary: `${actor.name} changed the status from ${before.status.replace(/_/g, ' ')} to ${input.leadStatus.replace(/_/g, ' ')}`,
            meta: { from: before.status, to: input.leadStatus, callId: id },
          });
        }
      }

      if (input.followUpAt) {
        const [result] = await connection.execute(
          `INSERT INTO follow_ups (lead_id, assigned_to, created_by, due_at, note)
           VALUES (?, ?, ?, ?, ?)`,
          [leadId, actor.id, actor.id, input.followUpAt, input.followUpNote],
        );
        createdFollowUpId = (result as { insertId: number }).insertId;

        await recordActivityTx(connection, {
          leadId,
          userId: actor.id,
          type: 'follow_up_created',
          summary: `${actor.name} scheduled a follow-up`,
          meta: { dueAt: input.followUpAt.toISOString(), followUpId: createdFollowUpId },
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

  return { call, followUpId, deduplicated: false };
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

  for (const [index, input] of inputs.entries()) {
    try {
      const result = await logCall(input, actor);
      if (result.deduplicated) duplicates += 1;
      else accepted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not log this call.';
      failures.push({ index, clientUuid: input.clientUuid, message });
      logger.warn('Batch call log rejected an entry', { index, message });
    }
  }

  return { accepted, duplicates, failures };
}

/* -------------------------------------------------------------------------- */
/* Writing up a call that already exists                                       */
/* -------------------------------------------------------------------------- */

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
 * second row for the same physical call.
 *
 * So this fills in the parts only a person can supply — which customer it was, what was
 * said, what to do next — against a row that is already there. There is exactly one row
 * per physical call, before and after, which is what makes duplicate call records
 * impossible rather than merely unlikely.
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
): Promise<LogCallResult> {
  const existing = await findCall(callId, ownershipScope(actor));
  if (!existing) throw notFound('Call not found.');

  /*
   * Which lead this call belongs to, in order of authority: the one it already has, the
   * one the telecaller picked, then the one its number matches.
   *
   * The phone fallback is what makes the common case one tap. An incoming call from a
   * number that matches exactly one lead should not ask which customer it was — the
   * server already knows, and `logCall` answers the same question the same way.
   */
  let leadId: number | null = existing.leadId;

  if (leadId === null && input.leadId) {
    const lead = await findLeadOwner(input.leadId);
    if (!lead) throw notFound('Lead not found.');
    if (!canActOnOwner(actor, lead.assignedTo)) throw notFound('Lead not found.');
    leadId = lead.id;
  }

  if (leadId === null) {
    const matches = await findLeadsByPhone(existing.phone, actor.id);
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

  const followUpId = await withTransaction(async (connection) => {
    await recordCallTx(connection, callId, actor.id, {
      leadId,
      outcome,
      durationSeconds,
    });

    if (leadId === null) return null;

    /*
     * The timeline entry is written here rather than when the call was imported.
     *
     * An imported call with no lead had no timeline to be written to, and one that did
     * match a lead was logged by `logCall` on the way in. Either way this is the first
     * moment a written-up call has both a lead and something worth saying about it.
     */
    await recordActivityTx(connection, {
      leadId,
      userId: actor.id,
      type: 'call_logged',
      summary: describeCall(actor.name, existing.direction, outcome, durationSeconds),
      meta: {
        callId,
        direction: existing.direction,
        outcome,
        durationSeconds,
        recordedFrom: 'incoming_list',
      },
    });

    if (input.note) {
      await insertNoteTx(connection, {
        leadId,
        userId: actor.id,
        kind: 'call_note',
        body: input.note,
        callId,
        clientUuid: null,
      });

      await recordActivityTx(connection, {
        leadId,
        userId: actor.id,
        type: 'note_added',
        summary: `${actor.name} wrote up this call`,
        meta: { callId },
      });
    }

    if (input.leadStatus) {
      const before = await findLeadOwner(leadId);
      if (before && before.status !== input.leadStatus) {
        await updateLeadStatusTx(connection, leadId, input.leadStatus);
        await recordActivityTx(connection, {
          leadId,
          userId: actor.id,
          type: 'status_changed',
        summary: `${actor.name} changed the status from ${before.status.replace(/_/g, ' ')} to ${input.leadStatus.replace(/_/g, ' ')}`,
          meta: { from: before.status, to: input.leadStatus, callId },
        });
      }
    }

    let createdFollowUpId: number | null = null;

    if (input.followUpAt) {
      const [result] = await connection.execute(
        `INSERT INTO follow_ups (lead_id, assigned_to, created_by, due_at, note)
         VALUES (?, ?, ?, ?, ?)`,
        [leadId, actor.id, actor.id, input.followUpAt, input.followUpNote],
      );
      createdFollowUpId = (result as { insertId: number }).insertId;

      await recordActivityTx(connection, {
        leadId,
        userId: actor.id,
        type: 'follow_up_created',
        summary: `${actor.name} scheduled a follow-up`,
        meta: { dueAt: input.followUpAt.toISOString(), followUpId: createdFollowUpId },
      });
    }

    /*
     * Attaching a call to a lead changes when that lead was last contacted, and the
     * dashboard's "not yet called" tile reads that column. Without this the lead would
     * keep claiming nobody had ever spoken to it.
     */
    await refreshLeadCachesTx(connection, leadId);

    return createdFollowUpId;
  });

  const call = await findCall(callId, null);
  if (!call) throw notFound('Call not found after recording.');

  return { call, followUpId, deduplicated: false };
}
