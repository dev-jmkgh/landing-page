import type { PoolConnection } from 'mysql2/promise';
import {
  execute,
  query,
  queryOne,
  type ResultSetHeader,
  type RowDataPacket,
  type SqlParam,
} from '../../../db/pool';
import type { OwnershipScope } from '../actor';
import {
  likeTerm,
  resolvePage,
  type CallChannel,
  type CallDirection,
  type CallOutcome,
  type CallSource,
  type LeadStatus,
  type Paginated,
} from '../shared.schema';
import type { CallListQuery } from './call.schema';

/** Data access for `calls` and `call_recordings`. */

export interface CallRow extends RowDataPacket {
  id: number;
  lead_id: number | null;
  lead_reference: string | null;
  lead_name: string | null;
  user_id: number;
  user_name: string | null;
  phone: string;
  direction: CallDirection;
  outcome: CallOutcome;
  channel: CallChannel;
  source: CallSource;
  duration_seconds: number;
  started_at: Date;
  ended_at: Date | null;
  followed_up: number;
  recorded_at: Date | null;
  lead_status: LeadStatus | null;
  recording_id: number | null;
  recording_duration: number | null;
  created_at: Date;
}

export type CallRecord = {
  id: number;
  leadId: number | null;
  leadReference: string | null;
  leadName: string | null;
  /**
   * The lead's current status, carried on the call so a list of calls can show it without
   * a second request per row. Null when the call belongs to no lead.
   */
  leadStatus: LeadStatus | null;
  userId: number;
  userName: string | null;
  phone: string;
  direction: CallDirection;
  outcome: CallOutcome;
  channel: CallChannel;
  source: CallSource;
  durationSeconds: number;
  startedAt: string;
  endedAt: string | null;
  followedUp: boolean;
  /**
   * When a telecaller wrote this call up, or null if nobody has.
   *
   * Not the same question as `followedUp`. An incoming call can be dealt with — called
   * back, marked done — without anybody recording what was said, and a call can be
   * written up in full and still need a callback. The Incoming list needs both.
   */
  recordedAt: string | null;
  /** Whether a recording exists. The storage key is never exposed to a client. */
  hasRecording: boolean;
  recordingId: number | null;
  recordingDuration: number | null;
  createdAt: string;
};

export function toCallRecord(row: CallRow): CallRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    leadReference: row.lead_reference,
    leadName: row.lead_name,
    leadStatus: row.lead_status,
    userId: row.user_id,
    userName: row.user_name,
    phone: row.phone,
    direction: row.direction,
    outcome: row.outcome,
    channel: row.channel,
    source: row.source,
    durationSeconds: Number(row.duration_seconds),
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    followedUp: row.followed_up === 1,
    recordedAt: row.recorded_at ? row.recorded_at.toISOString() : null,
    hasRecording: row.recording_id !== null,
    recordingId: row.recording_id,
    recordingDuration: row.recording_duration === null ? null : Number(row.recording_duration),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const CALL_SELECT = `
  SELECT c.id, c.lead_id, l.reference AS lead_reference, l.customer_name AS lead_name,
         c.user_id, u.name AS user_name, c.phone, c.direction, c.outcome, c.channel,
         c.source, c.duration_seconds, c.started_at, c.ended_at, c.followed_up,
         c.recorded_at, l.status AS lead_status,
         r.id AS recording_id, r.duration_seconds AS recording_duration, c.created_at
    FROM calls c
    LEFT JOIN leads l ON l.id = c.lead_id
    LEFT JOIN telecaller_users u ON u.id = c.user_id
    LEFT JOIN call_recordings r ON r.call_id = c.id
`;

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function findCall(id: number, scope: OwnershipScope): Promise<CallRecord | null> {
  const params: SqlParam[] = [id];
  let where = 'WHERE c.id = ?';

  if (scope !== null) {
    where += ' AND c.user_id = ?';
    params.push(scope);
  }

  const row = await queryOne<CallRow>(`${CALL_SELECT} ${where} LIMIT 1`, params);
  return row ? toCallRecord(row) : null;
}

export async function findCallByClientUuid(clientUuid: string): Promise<CallRecord | null> {
  const row = await queryOne<CallRow>(`${CALL_SELECT} WHERE c.client_uuid = ? LIMIT 1`, [
    clientUuid,
  ]);
  return row ? toCallRecord(row) : null;
}

export async function findCallByProviderSid(sid: string): Promise<CallRecord | null> {
  const row = await queryOne<CallRow>(`${CALL_SELECT} WHERE c.provider_call_sid = ? LIMIT 1`, [
    sid,
  ]);
  return row ? toCallRecord(row) : null;
}

function buildCallFilters(
  filters: CallListQuery,
  scope: OwnershipScope,
): { where: string; params: SqlParam[] } {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (scope !== null) {
    // A telecaller sees only their own calls. Applied first so no client filter widens it.
    conditions.push('c.user_id = ?');
    params.push(scope);
  } else if (filters.userId) {
    conditions.push('c.user_id = ?');
    params.push(filters.userId);
  }

  if (filters.leadId) {
    conditions.push('c.lead_id = ?');
    params.push(filters.leadId);
  }
  if (filters.direction) {
    conditions.push('c.direction = ?');
    params.push(filters.direction);
  }
  if (filters.outcome) {
    conditions.push('c.outcome = ?');
    params.push(filters.outcome);
  }
  if (filters.channel) {
    conditions.push('c.channel = ?');
    params.push(filters.channel);
  }
  if (filters.withRecording === true) conditions.push('r.id IS NOT NULL');
  if (filters.withRecording === false) conditions.push('r.id IS NULL');

  if (filters.pendingCallback === true) {
    // The callback queue: an unanswered call nobody has come back to yet.
    conditions.push("c.outcome IN ('missed','rejected','busy','unreachable','no_answer')");
    conditions.push('c.followed_up = 0');
  }

  if (filters.from) {
    conditions.push('c.started_at >= ?');
    params.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    conditions.push('c.started_at <= ?');
    params.push(`${filters.to} 23:59:59`);
  }

  if (filters.q) {
    const term = likeTerm(filters.q);
    const digits = filters.q.replace(/\D/g, '');

    if (digits.length >= 4) {
      conditions.push(
        `(l.customer_name LIKE ? OR l.reference LIKE ? OR u.name LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(c.phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?)`,
      );
      params.push(term, term, term, `%${digits}%`);
    } else {
      conditions.push('(l.customer_name LIKE ? OR l.reference LIKE ? OR u.name LIKE ?)');
      params.push(term, term, term);
    }
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export async function listCalls(
  filters: CallListQuery,
  scope: OwnershipScope,
): Promise<Paginated<CallRecord>> {
  const { where, params } = buildCallFilters(filters, scope);

  /**
   * The count query repeats the joins.
   *
   * They are not decoration: `q` searches the lead name and the employee name, and
   * `withRecording` filters on the recordings join. Counting without them would return
   * a total that disagrees with the page — which shows up as a pager offering a page
   * that turns out to be empty.
   */
  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM calls c
       LEFT JOIN leads l ON l.id = c.lead_id
       LEFT JOIN telecaller_users u ON u.id = c.user_id
       LEFT JOIN call_recordings r ON r.call_id = c.id
       ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  const rows = await query<CallRow>(
    `${CALL_SELECT} ${where} ORDER BY c.started_at DESC, c.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toCallRecord), page, pageSize, total, totalPages };
}

/** One lead's call history, for the detail screen and the timeline. */
export async function listLeadCalls(leadId: number, limit = 100): Promise<CallRecord[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await query<CallRow>(
    `${CALL_SELECT} WHERE c.lead_id = ? ORDER BY c.started_at DESC, c.id DESC LIMIT ${bounded}`,
    [leadId],
  );
  return rows.map(toCallRecord);
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export type InsertCallData = {
  clientUuid: string | null;
  leadId: number | null;
  userId: number;
  phone: string;
  direction: CallDirection;
  outcome: CallOutcome;
  channel: CallChannel;
  source: CallSource;
  durationSeconds: number;
  startedAt: Date;
  endedAt: Date | null;
  providerCallSid: string | null;
};

export async function insertCallTx(
  connection: PoolConnection,
  data: InsertCallData,
): Promise<number> {
  const [result] = await connection.execute(
    `INSERT INTO calls
       (client_uuid, lead_id, user_id, phone, direction, outcome, channel, source,
        duration_seconds, started_at, ended_at, provider_call_sid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.clientUuid,
      data.leadId,
      data.userId,
      data.phone,
      data.direction,
      data.outcome,
      data.channel,
      data.source,
      data.durationSeconds,
      data.startedAt,
      data.endedAt,
      data.providerCallSid,
    ],
  );
  return (result as { insertId: number }).insertId;
}

/**
 * Marks a missed call resolved.
 *
 * Scoped to the caller unless they are a supervisor, so a telecaller cannot clear
 * someone else's callback queue.
 */
export async function setCallFollowedUp(
  id: number,
  followedUp: boolean,
  scope: OwnershipScope,
): Promise<boolean> {
  const params: SqlParam[] = [followedUp ? 1 : 0, id];
  let where = 'WHERE id = ?';

  if (scope !== null) {
    where += ' AND user_id = ?';
    params.push(scope);
  }

  const result = await execute(`UPDATE calls SET followed_up = ? ${where}`, params);
  return result.affectedRows > 0;
}

/**
 * Marks every earlier unanswered call to the same number as followed up.
 *
 * Called when a connected call is logged. Without it a telecaller who tried four times
 * before getting through would keep four items in their callback queue for a
 * conversation that has already happened — and would learn to ignore the queue.
 */
export async function resolveEarlierMissedCallsTx(
  connection: PoolConnection,
  userId: number,
  leadId: number | null,
  phone: string,
  before: Date,
): Promise<void> {
  const digits = phone.replace(/\D/g, '');
  const key = digits.length > 9 ? digits.slice(-9) : digits;
  if (key.length < 6) return;

  await connection.execute(
    `UPDATE calls
        SET followed_up = 1
      WHERE user_id = ?
        AND followed_up = 0
        AND outcome IN ('missed','rejected','busy','unreachable','no_answer')
        AND started_at < ?
        AND (
             (? IS NOT NULL AND lead_id = ?)
          OR REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
        )`,
    [userId, before, leadId, leadId, `%${key}`],
  );
}

/* -------------------------------------------------------------------------- */
/* Recordings                                                                  */
/* -------------------------------------------------------------------------- */

export type InsertRecordingData = {
  callId: number;
  leadId: number | null;
  userId: number | null;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  provider: string | null;
};

export async function insertRecording(data: InsertRecordingData): Promise<number> {
  const result = await execute(
    `INSERT INTO call_recordings
       (call_id, lead_id, user_id, storage_key, mime_type, size_bytes, duration_seconds,
        origin, provider, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'cloud', ?, NOW())`,
    [
      data.callId,
      data.leadId,
      data.userId,
      data.storageKey,
      data.mimeType,
      data.sizeBytes,
      data.durationSeconds,
      data.provider,
    ],
  );
  return result.insertId;
}

export interface RecordingRow extends RowDataPacket {
  id: number;
  call_id: number;
  lead_id: number | null;
  lead_reference: string | null;
  lead_name: string | null;
  user_id: number | null;
  user_name: string | null;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number;
  provider: string | null;
  started_at: Date | null;
  created_at: Date;
}

export type RecordingRecord = {
  id: number;
  callId: number;
  leadId: number | null;
  leadReference: string | null;
  leadName: string | null;
  userId: number | null;
  userName: string | null;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  provider: string | null;
  callStartedAt: string | null;
  createdAt: string;
};

/** `storage_key` is read internally and never mapped into the record. */
function toRecordingRecord(row: RecordingRow): RecordingRecord {
  return {
    id: row.id,
    callId: row.call_id,
    leadId: row.lead_id,
    leadReference: row.lead_reference,
    leadName: row.lead_name,
    userId: row.user_id,
    userName: row.user_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    durationSeconds: Number(row.duration_seconds),
    provider: row.provider,
    callStartedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const RECORDING_SELECT = `
  SELECT r.id, r.call_id, r.lead_id, l.reference AS lead_reference,
         l.customer_name AS lead_name, r.user_id, u.name AS user_name,
         r.storage_key, r.mime_type, r.size_bytes, r.duration_seconds, r.provider,
         c.started_at, r.created_at
    FROM call_recordings r
    LEFT JOIN calls c ON c.id = r.call_id
    LEFT JOIN leads l ON l.id = r.lead_id
    LEFT JOIN telecaller_users u ON u.id = r.user_id
`;

export type RecordingFilters = {
  page: number;
  pageSize: number;
  userId?: number;
  leadId?: number;
  q?: string;
  from?: string;
  to?: string;
};

export async function listRecordings(
  filters: RecordingFilters,
): Promise<Paginated<RecordingRecord>> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.userId) {
    conditions.push('r.user_id = ?');
    params.push(filters.userId);
  }
  if (filters.leadId) {
    conditions.push('r.lead_id = ?');
    params.push(filters.leadId);
  }
  if (filters.from) {
    conditions.push('r.created_at >= ?');
    params.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    conditions.push('r.created_at <= ?');
    params.push(`${filters.to} 23:59:59`);
  }
  if (filters.q) {
    const term = likeTerm(filters.q);
    conditions.push('(l.customer_name LIKE ? OR l.reference LIKE ? OR u.name LIKE ?)');
    params.push(term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM call_recordings r
       LEFT JOIN leads l ON l.id = r.lead_id
       LEFT JOIN telecaller_users u ON u.id = r.user_id
       ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  const rows = await query<RecordingRow>(
    `${RECORDING_SELECT} ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toRecordingRecord), page, pageSize, total, totalPages };
}

/** The storage key, for the authenticated playback route only. */
export async function findRecordingKey(
  id: number,
): Promise<{ key: string; mime: string; leadId: number | null; userId: number | null } | null> {
  const row = await queryOne<
    RowDataPacket & {
      storage_key: string;
      mime_type: string;
      lead_id: number | null;
      user_id: number | null;
    }
  >(
    'SELECT storage_key, mime_type, lead_id, user_id FROM call_recordings WHERE id = ? LIMIT 1',
    [id],
  );

  return row
    ? { key: row.storage_key, mime: row.mime_type, leadId: row.lead_id, userId: row.user_id }
    : null;
}

/**
 * Writes up an existing call: links it to a lead, corrects what the log got wrong, and
 * stamps it as recorded.
 *
 * Only ever touches columns the telecaller is entitled to change. `lead_id` moves only
 * from NULL — a call already filed against a customer is never re-pointed by this — and
 * the row is matched on `user_id` as well as `id`, so one telecaller cannot write up
 * another's call.
 */
export async function recordCallTx(
  connection: PoolConnection,
  callId: number,
  userId: number,
  changes: {
    leadId?: number | null;
    outcome?: CallOutcome;
    durationSeconds?: number;
  },
): Promise<void> {
  const sets: string[] = ['recorded_at = CURRENT_TIMESTAMP', 'followed_up = 1'];
  const params: SqlParam[] = [];

  if (changes.leadId !== undefined && changes.leadId !== null) {
    /*
     * The guard is on the column, not in the WHERE clause.
     *
     * `AND lead_id IS NULL` there would drop the whole update — outcome, duration and
     * the recorded stamp with it — whenever the call already had a lead. `IFNULL` keeps
     * the rest of the write and makes re-attaching a no-op instead of a refusal.
     */
    sets.push('lead_id = IFNULL(lead_id, ?)');
    params.push(changes.leadId);
  }

  if (changes.outcome !== undefined) {
    sets.push('outcome = ?');
    params.push(changes.outcome);
  }

  if (changes.durationSeconds !== undefined) {
    sets.push('duration_seconds = ?');
    params.push(changes.durationSeconds);
  }

  params.push(callId, userId);

  await connection.execute(
    `UPDATE calls SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
    params,
  );
}
/**
 * Attaches the actor's unattached calls from this number to a lead that has just been created.
 *
 * WHY THIS EXISTS
 * ---------------
 * `logCall` already matches an incoming call to a lead by phone number, so a call that
 * arrives AFTER the lead exists attaches itself. The reverse order has no such path: a
 * customer rings a number nobody has a lead for, the call is stored with `lead_id NULL`,
 * and the employee then taps "Create lead" on it. Without this the new lead would open
 * with an empty history despite having been created from a conversation.
 *
 * WHY IT CANNOT STEAL A CALL
 * --------------------------
 * `lead_id IS NULL` means only calls that belong to no lead are eligible — a call already
 * filed against a customer is never re-pointed, so creating a lead can never move history
 * out of another lead's record. `user_id = ?` restricts it to the actor's own calls, so a
 * new lead cannot absorb a colleague's conversations. Both conditions are in the WHERE
 * clause rather than checked in application code, because this runs inside the lead's
 * creation transaction and a missed check there would be a silent data leak.
 *
 * Matching is the trailing nine digits, the same key `resolveEarlierMissedCallsTx` and the
 * server's `phoneMatchKey` use: the call log writes `+919876543210` where the lead form
 * was given `9876543210`, and an exact comparison would find nothing in the common case.
 *
 * Adopted calls are marked followed up, but deliberately NOT marked recorded.
 *
 * Those are different claims and an earlier version made both. Creating the lead deals
 * with the call — the telecaller has acted, so the row should stop demanding attention —
 * but it says nothing about what was discussed. Stamping `recorded_at` here asserted that
 * somebody had written the call up when nobody had, and it did it in bulk: create one
 * lead and every historical call from that number silently became "record added" with no
 * note behind it, so the Incoming list stopped asking for the very thing the business
 * wants collected.
 *
 * A detected call is evidence that a conversation happened. Only a person can say what
 * was said, and until one has, these stay unrecorded.
 *
 * Returns how many calls were adopted, so the caller can decide whether the lead's
 * timeline deserves a line about it.
 */
export async function adoptOrphanCallsTx(
  connection: PoolConnection,
  userId: number,
  leadId: number,
  phones: (string | null | undefined)[],
): Promise<number> {
  const keys = phones
    .map((phone) => {
      const digits = (phone ?? '').replace(/\D/g, '');
      return digits.length > 9 ? digits.slice(-9) : digits;
    })
    // Six digits is the shortest thing worth matching on. Below that a LIKE '%...' would
    // sweep up unrelated numbers, and adopting the wrong call is worse than adopting none.
    .filter((key) => key.length >= 6);

  if (keys.length === 0) return 0;

  const clause = keys
    .map(
      () =>
        `REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?`,
    )
    .join(' OR ');

  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE calls
        SET lead_id = ?,
            followed_up = 1
      WHERE user_id = ?
        AND lead_id IS NULL
        AND (${clause})`,
    [leadId, userId, ...keys.map((key) => `%${key}`)],
  );

  return result.affectedRows;
}
