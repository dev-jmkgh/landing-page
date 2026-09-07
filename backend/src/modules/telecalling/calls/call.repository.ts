import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import type { OwnershipScope } from '../actor';
import {
  likeTerm,
  resolvePage,
  type CallChannel,
  type CallDirection,
  type CallOutcome,
  type CallSource,
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
  recording_id: number | null;
  recording_duration: number | null;
  created_at: Date;
}

export type CallRecord = {
  id: number;
  leadId: number | null;
  leadReference: string | null;
  leadName: string | null;
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
