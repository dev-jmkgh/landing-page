import { withTransaction } from '../../../db/pool';
import { badRequest, notFound } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { canActOnOwner, type Actor } from '../actor';
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
  insertCallTx,
  resolveEarlierMissedCallsTx,
  type CallRecord,
} from './call.repository';
import type { LogCallInput } from './call.schema';

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
