import type { PoolConnection } from 'mysql2/promise';
import {
  query,
  queryOne,
  type ResultSetHeader,
  type RowDataPacket,
  type SqlParam,
} from '../../../db/pool';
import type { Page } from '../hr.schema';
import {
  ACTIVE_REQUEST_STATUSES,
  PROFILE_UPDATE_FIELDS,
  type HrRequest,
  type HrRequestCategory,
  type HrRequestComment,
  type HrRequestStatus,
  type HrRequestStatusFilter,
  type ProfileUpdatePayload,
} from './requests.schema';

/**
 * SQL for `hr_requests` and `hr_request_comments` (migration 029).
 *
 * Joins `hr_users` only — never a telecalling table.
 */

interface RequestRow extends RowDataPacket {
  id: number;
  user_id: number;
  employee_name: string;
  employee_code: string;
  category: HrRequestCategory;
  subject: string;
  details: string | null;
  payload: unknown;
  status: HrRequestStatus;
  resolved_by_name: string | null;
  resolved_at: Date | string | null;
  resolution_note: string | null;
  last_activity_at: Date | string;
  created_at: Date | string;
  comment_count: number | string;
}

interface CommentRow extends RowDataPacket {
  id: number;
  author_type: 'employee' | 'admin' | 'system';
  author_name: string | null;
  body: string | null;
  status_from: HrRequestStatus | null;
  status_to: HrRequestStatus | null;
  created_at: Date | string;
}

const iso = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

/**
 * The stored payload, narrowed to the known keys.
 *
 * mysql2 hands a JSON column back already parsed on some paths and as text on others,
 * so both are accepted. Anything that is not an object of known keys reads as null
 * rather than reaching the app as an unexpected shape.
 */
export function parsePayload(value: unknown): ProfileUpdatePayload | null {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const source = raw as Record<string, unknown>;
  const payload: Record<string, string | null> = {};
  for (const field of PROFILE_UPDATE_FIELDS) {
    if (!(field in source)) continue;
    const entry = source[field];
    if (entry === null || typeof entry === 'string') payload[field] = entry;
  }
  return Object.keys(payload).length > 0 ? (payload as ProfileUpdatePayload) : null;
}

function toRequest(row: RequestRow): HrRequest {
  return {
    id: row.id,
    userId: row.user_id,
    employeeName: row.employee_name,
    employeeCode: row.employee_code,
    category: row.category,
    subject: row.subject,
    details: row.details,
    payload: row.category === 'profile_update' ? parsePayload(row.payload) : null,
    status: row.status,
    resolvedByName: row.resolved_by_name,
    resolvedAt: iso(row.resolved_at),
    resolutionNote: row.resolution_note,
    lastActivityAt: new Date(row.last_activity_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    commentCount: Number(row.comment_count ?? 0),
    canCancel: ACTIVE_REQUEST_STATUSES.includes(row.status),
  };
}

function toComment(row: CommentRow): HrRequestComment {
  return {
    id: row.id,
    authorType: row.author_type,
    authorName: row.author_name,
    body: row.body,
    statusFrom: row.status_from,
    statusTo: row.status_to,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/*
 * `comment_count` counts entries with a body: comments from either side, and status
 * changes that carried a note. A bare "moved to in progress" is not a comment.
 * A correlated count over an index on (request_id, id), and only ever for one page.
 */
const REQUEST_SELECT = `
  SELECT r.id, r.user_id, u.name AS employee_name, u.employee_code,
         r.category, r.subject, r.details, r.payload, r.status,
         r.resolved_by_name, r.resolved_at, r.resolution_note,
         r.last_activity_at, r.created_at,
         (SELECT COUNT(*) FROM hr_request_comments c
           WHERE c.request_id = r.id AND c.body IS NOT NULL) AS comment_count
    FROM hr_requests r
    JOIN hr_users u ON u.id = r.user_id
`;

/**
 * One request. With `ownerId`, only if it belongs to that employee — the app's every
 * read goes through this, so somebody else's request is simply not found.
 */
export async function findRequest(id: number, ownerId?: number): Promise<HrRequest | null> {
  const row = await queryOne<RequestRow>(
    `${REQUEST_SELECT} WHERE r.id = ?${ownerId === undefined ? '' : ' AND r.user_id = ?'} LIMIT 1`,
    ownerId === undefined ? [id] : [id, ownerId],
  );
  return row ? toRequest(row) : null;
}

export async function findRequestByClientKey(userId: number, clientKey: string): Promise<HrRequest | null> {
  const row = await queryOne<RequestRow>(
    `${REQUEST_SELECT} WHERE r.user_id = ? AND r.client_key = ? LIMIT 1`,
    [userId, clientKey],
  );
  return row ? toRequest(row) : null;
}

function statusCondition(filter: HrRequestStatusFilter, params: SqlParam[]): string {
  if (filter === 'active') return "r.status IN ('open', 'in_progress')";
  if (filter === 'closed') return "r.status IN ('resolved', 'rejected', 'cancelled')";
  params.push(filter);
  return 'r.status = ?';
}

export type RequestListFilters = {
  userId?: number;
  status?: HrRequestStatusFilter;
  category?: HrRequestCategory;
  q?: string;
  page: number;
  pageSize: number;
};

/**
 * One page of requests.
 *
 * `order`:
 *   - 'activity' — the employee's inbox: whatever moved most recently first.
 *   - 'queue'    — HR's queue: open, then in progress, then the rest; oldest first
 *                  within each, because the one waiting longest is the one to pick up.
 */
export async function listRequests(
  filters: RequestListFilters,
  order: 'activity' | 'queue',
): Promise<Page<HrRequest>> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.userId !== undefined) {
    conditions.push('r.user_id = ?');
    params.push(filters.userId);
  }
  if (filters.status) conditions.push(statusCondition(filters.status, params));
  if (filters.category) {
    conditions.push('r.category = ?');
    params.push(filters.category);
  }
  if (filters.q) {
    const term = `%${filters.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push('(r.subject LIKE ? OR u.name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)');
    params.push(term, term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_requests r JOIN hr_users u ON u.id = r.user_id ${where}`,
    params,
  );

  const orderBy =
    order === 'activity'
      ? 'r.last_activity_at DESC, r.id DESC'
      : `CASE r.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         r.created_at ASC, r.id ASC`;

  // LIMIT/OFFSET interpolated: Zod-validated positive integers, pageSize capped at 100.
  const rows = await query<RequestRow>(
    `${REQUEST_SELECT} ${where}
      ORDER BY ${orderBy}
      LIMIT ${Number(filters.pageSize)} OFFSET ${Number((filters.page - 1) * filters.pageSize)}`,
    params,
  );

  return {
    items: rows.map(toRequest),
    total: Number(count?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/** An employee's requests still waiting on somebody: open + in progress. */
export async function countActiveForUser(userId: number): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_requests
      WHERE user_id = ? AND status IN ('open', 'in_progress')`,
    [userId],
  );
  return Number(row?.total ?? 0);
}

/** HR's badge. Two numbers, from the `(status, created_at)` index. */
export async function countQueue(): Promise<{ open: number; inProgress: number }> {
  const row = await queryOne<RowDataPacket & { open_count: number; in_progress_count: number }>(
    `SELECT SUM(status = 'open') AS open_count, SUM(status = 'in_progress') AS in_progress_count
       FROM hr_requests WHERE status IN ('open', 'in_progress')`,
  );
  return { open: Number(row?.open_count ?? 0), inProgress: Number(row?.in_progress_count ?? 0) };
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                    */
/* -------------------------------------------------------------------------- */

const COMMENT_SELECT = `
  SELECT id, author_type, author_name, body, status_from, status_to, created_at
    FROM hr_request_comments
`;

/** One page of a request's timeline, OLDEST first — it reads as a conversation. */
export async function listComments(
  requestId: number,
  paging: { page: number; pageSize: number },
): Promise<Page<HrRequestComment>> {
  const count = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM hr_request_comments WHERE request_id = ?',
    [requestId],
  );
  const rows = await query<CommentRow>(
    `${COMMENT_SELECT} WHERE request_id = ? ORDER BY id ASC
      LIMIT ${Number(paging.pageSize)} OFFSET ${Number((paging.page - 1) * paging.pageSize)}`,
    [requestId],
  );
  return {
    items: rows.map(toComment),
    total: Number(count?.total ?? 0),
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

export async function findComment(id: number): Promise<HrRequestComment | null> {
  const row = await queryOne<CommentRow>(`${COMMENT_SELECT} WHERE id = ? LIMIT 1`, [id]);
  return row ? toComment(row) : null;
}

/**
 * The author's newest comment on a request, if it was written in the last two minutes.
 * See `addComment` in the service for why.
 */
export async function findRecentCommentBy(
  requestId: number,
  author: { type: 'employee' | 'admin'; id: number },
): Promise<(HrRequestComment & { body: string }) | null> {
  const row = await queryOne<CommentRow>(
    `${COMMENT_SELECT}
      WHERE request_id = ? AND author_type = ? AND author_id = ?
        AND status_to IS NULL AND body IS NOT NULL
        AND created_at >= NOW() - INTERVAL 2 MINUTE
      ORDER BY id DESC LIMIT 1`,
    [requestId, author.type, author.id],
  );
  return row && row.body !== null ? { ...toComment(row), body: row.body } : null;
}

/* -------------------------------------------------------------------------- */
/* Writes — always inside the caller's transaction                             */
/* -------------------------------------------------------------------------- */

export type LockedRequest = {
  id: number;
  userId: number;
  category: HrRequestCategory;
  subject: string;
  status: HrRequestStatus;
  payload: ProfileUpdatePayload | null;
};

/** Reads a request and locks it until the transaction ends. */
export async function lockRequestTx(
  connection: PoolConnection,
  id: number,
  ownerId?: number,
): Promise<LockedRequest | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id, user_id, category, subject, status, payload
       FROM hr_requests
      WHERE id = ?${ownerId === undefined ? '' : ' AND user_id = ?'}
      FOR UPDATE`,
    ownerId === undefined ? [id] : [id, ownerId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    category: row.category as HrRequestCategory,
    subject: String(row.subject),
    status: row.status as HrRequestStatus,
    payload: row.category === 'profile_update' ? parsePayload(row.payload) : null,
  };
}

/** Locks the employee row: the serialisation point for "one open profile update". */
export async function lockHrUserTx(connection: PoolConnection, userId: number): Promise<boolean> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT id FROM hr_users WHERE id = ? FOR UPDATE',
    [userId],
  );
  return rows.length > 0;
}

export async function findIdByClientKeyTx(
  connection: PoolConnection,
  userId: number,
  clientKey: string,
): Promise<number | null> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT id FROM hr_requests WHERE user_id = ? AND client_key = ? LIMIT 1',
    [userId, clientKey],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export async function hasActiveProfileUpdateTx(connection: PoolConnection, userId: number): Promise<boolean> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id FROM hr_requests
      WHERE user_id = ? AND category = 'profile_update' AND status IN ('open', 'in_progress')
      LIMIT 1`,
    [userId],
  );
  return rows.length > 0;
}

export async function insertRequestTx(
  connection: PoolConnection,
  input: {
    userId: number;
    category: HrRequestCategory;
    subject: string;
    details: string | null;
    payload: ProfileUpdatePayload | null;
    clientKey: string;
  },
): Promise<number> {
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO hr_requests (user_id, category, subject, details, payload, client_key, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      input.userId,
      input.category,
      input.subject,
      input.details,
      input.payload ? JSON.stringify(input.payload) : null,
      input.clientKey,
    ],
  );
  return result.insertId;
}

/**
 * Appends a timeline entry. `author_name` is a snapshot, so the timeline survives a
 * rename; for an employee it is read from `hr_users` in the same statement rather than
 * trusted from the token, which can be minutes stale.
 */
export async function insertCommentTx(
  connection: PoolConnection,
  input: {
    requestId: number;
    author: { type: 'employee'; id: number } | { type: 'admin'; id: number; name: string };
    body: string | null;
    statusFrom?: HrRequestStatus | null;
    statusTo?: HrRequestStatus | null;
  },
): Promise<number> {
  if (input.author.type === 'employee') {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO hr_request_comments
         (request_id, author_type, author_id, author_name, body, status_from, status_to)
       SELECT ?, 'employee', u.id, u.name, ?, ?, ? FROM hr_users u WHERE u.id = ?`,
      [
        input.requestId,
        input.body,
        input.statusFrom ?? null,
        input.statusTo ?? null,
        input.author.id,
      ],
    );
    return result.insertId;
  }

  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO hr_request_comments
       (request_id, author_type, author_id, author_name, body, status_from, status_to)
     VALUES (?, 'admin', ?, ?, ?, ?, ?)`,
    [
      input.requestId,
      input.author.id,
      input.author.name.slice(0, 120),
      input.body,
      input.statusFrom ?? null,
      input.statusTo ?? null,
    ],
  );
  return result.insertId;
}

/** "Something happened": the employee's inbox sorts on this. */
export async function touchRequestTx(connection: PoolConnection, id: number): Promise<void> {
  await connection.execute('UPDATE hr_requests SET last_activity_at = NOW() WHERE id = ?', [id]);
}

/**
 * Moves the status, guarded on the status the caller locked and checked, so the change
 * can only ever apply from the state it was decided against.
 */
export async function setStatusTx(
  connection: PoolConnection,
  input: {
    id: number;
    from: HrRequestStatus;
    to: HrRequestStatus;
    /** Set for an HR decision (resolved / rejected); the employee's cancel has none. */
    decidedBy?: { id: number; name: string; note: string | null };
  },
): Promise<boolean> {
  const decided = input.decidedBy;
  const [result] = await connection.execute<ResultSetHeader>(
    decided
      ? `UPDATE hr_requests
            SET status = ?, last_activity_at = NOW(),
                resolved_by = ?, resolved_by_name = ?, resolved_at = NOW(), resolution_note = ?
          WHERE id = ? AND status = ?`
      : `UPDATE hr_requests SET status = ?, last_activity_at = NOW() WHERE id = ? AND status = ?`,
    decided
      ? [input.to, decided.id, decided.name.slice(0, 120), decided.note, input.id, input.from]
      : [input.to, input.id, input.from],
  );
  return result.affectedRows > 0;
}
