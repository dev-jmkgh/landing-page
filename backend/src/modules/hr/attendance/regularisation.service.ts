import { execute, query, queryOne, type RowDataPacket } from '../../../db/pool';
import { logger } from '../../../utils/logger';
import {
  LOCAL_TODAY,
  type Regularisation,
  type RegularisationStatus,
} from './attendance.schema';

/**
 * Regularisation: asking for a missing punch to be corrected.
 *
 * The request is a record in its own right, not an edit queued against the day. It is
 * raised, it waits, it is decided with a reason, and all of that survives the
 * attendance row being changed — so the question "why does this day say 09:00 when the
 * app never saw a punch?" always has an answer.
 *
 * An approval WRITES the correction and marks the day `source = 'regularisation'`, so a
 * corrected day is permanently distinguishable from one somebody actually punched.
 */

/**
 * How far back a correction may reach.
 *
 * Thirty days, because payroll closes and a correction to a period already paid is not
 * a self-service action — it is a conversation with HR. Without a bound this endpoint
 * would let somebody fill in a year of absences.
 */
export const MAX_BACKDATE_DAYS = 30;

interface Row extends RowDataPacket {
  id: number;
  user_id: number;
  employee_name?: string;
  employee_code?: string;
  work_date: string;
  requested_check_in_at: Date | string | null;
  requested_check_out_at: Date | string | null;
  reason: string;
  status: RegularisationStatus;
  reviewed_at: Date | string | null;
  review_note: string | null;
  created_at: Date | string;
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

function toRecord(row: Row): Regularisation {
  return {
    id: row.id,
    userId: row.user_id,
    employeeName: row.employee_name,
    employeeCode: row.employee_code,
    workDate: String(row.work_date),
    requestedCheckInAt: iso(row.requested_check_in_at),
    requestedCheckOutAt: iso(row.requested_check_out_at),
    reason: row.reason,
    status: row.status,
    reviewedAt: iso(row.reviewed_at),
    reviewNote: row.review_note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/*
 * `work_date` is formatted in SQL for the reason given in attendance.service: a bare
 * DATE read through a UTC-pinned driver becomes midnight UTC and can render as the
 * previous day.
 */
const SELECT = `
  SELECT r.id, r.user_id,
         u.name AS employee_name, u.employee_code,
         DATE_FORMAT(r.work_date, '%Y-%m-%d') AS work_date,
         r.requested_check_in_at, r.requested_check_out_at,
         r.reason, r.status, r.reviewed_at, r.review_note, r.created_at
    FROM hr_regularisations r
    JOIN hr_users u ON u.id = r.user_id
`;

export type RaiseInput = {
  workDate: string;
  /** Local wall clock `HH:MM` on `workDate`, or null to leave that punch alone. */
  checkInAt: string | null;
  checkOutAt: string | null;
  reason: string;
};

export type RaiseResult =
  | { ok: true; request: Regularisation }
  | { ok: false; reason: 'future_date' | 'too_old' | 'already_open' };

/**
 * Raises a request.
 *
 * The two date guards are enforced in SQL against the LOCAL date rather than compared
 * in Node. `LOCAL_TODAY` is the company's calendar day; a Node-side `new Date()` is the
 * server's, and the two differ for five and a half hours out of every twenty-four.
 */
export async function raise(userId: number, input: RaiseInput): Promise<RaiseResult> {
  const bounds = await queryOne<RowDataPacket & { is_future: number; is_too_old: number }>(
    `SELECT (? > ${LOCAL_TODAY}) AS is_future,
            (? < DATE_SUB(${LOCAL_TODAY}, INTERVAL ? DAY)) AS is_too_old`,
    [input.workDate, input.workDate, MAX_BACKDATE_DAYS],
  );

  if (Number(bounds?.is_future) === 1) return { ok: false, reason: 'future_date' };
  if (Number(bounds?.is_too_old) === 1) return { ok: false, reason: 'too_old' };

  /*
   * One OPEN request per day. MySQL has no partial unique index, so this is a read
   * before the write — and a race here is benign: the worst case is two pending
   * requests for one day, which an approver sees together and decides once. Enforcing
   * it with a unique key instead would wrongly block a resubmission after a rejection.
   */
  const open = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_regularisations
      WHERE user_id = ? AND work_date = ? AND status = 'pending'`,
    [userId, input.workDate],
  );
  if (Number(open?.total ?? 0) > 0) return { ok: false, reason: 'already_open' };

  const result = await execute(
    `INSERT INTO hr_regularisations
       (user_id, work_date, requested_check_in_at, requested_check_out_at, reason)
     VALUES (?, ?,
             CASE WHEN ? IS NULL THEN NULL ELSE CAST(CONCAT(?, ' ', ?) AS DATETIME) END,
             CASE WHEN ? IS NULL THEN NULL ELSE CAST(CONCAT(?, ' ', ?) AS DATETIME) END,
             ?)`,
    [
      userId,
      input.workDate,
      input.checkInAt,
      input.workDate,
      input.checkInAt ? `${input.checkInAt}:00` : null,
      input.checkOutAt,
      input.workDate,
      input.checkOutAt ? `${input.checkOutAt}:00` : null,
      input.reason,
    ],
  );

  logger.info('HR regularisation raised', { userId, workDate: input.workDate });

  const row = await queryOne<Row>(`${SELECT} WHERE r.id = ?`, [result.insertId]);
  return { ok: true, request: toRecord(row!) };
}

export async function listForUser(userId: number): Promise<Regularisation[]> {
  const rows = await query<Row>(
    `${SELECT} WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 100`,
    [userId],
  );
  return rows.map(toRecord);
}

export async function listQueue(
  status: RegularisationStatus | 'all',
): Promise<Regularisation[]> {
  const rows = await query<Row>(
    `${SELECT}
      ${status === 'all' ? '' : 'WHERE r.status = ?'}
      ORDER BY (r.status = 'pending') DESC, r.created_at ASC
      LIMIT 500`,
    status === 'all' ? [] : [status],
  );
  return rows.map(toRecord);
}

export async function findById(id: number): Promise<Regularisation | null> {
  const row = await queryOne<Row>(`${SELECT} WHERE r.id = ?`, [id]);
  return row ? toRecord(row) : null;
}

export type DecisionResult = { ok: true } | { ok: false; reason: 'not_pending' };

/**
 * Approves a request and WRITES the correction.
 *
 * The correction is written as a SESSION, not as bare columns on the day.
 *
 * That matters since migration 019. The day's totals are DERIVED from its sessions and
 * recomputed on every punch, so a correction applied only to `hr_attendance` would
 * show hours with no sessions behind them — and the employee's very next check-in
 * would recompute the day from the sessions that exist and silently wipe it.
 *
 * Both statements are guarded so neither can apply twice: the request moves only
 * `WHERE status = 'pending'`, and the day is upserted in one statement. Two approvers
 * clicking together means the second updates zero rows and is told so.
 */
export async function approve(
  id: number,
  adminId: number | null,
  note: string | null,
): Promise<DecisionResult> {
  const moved = await execute(
    `UPDATE hr_regularisations
        SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
      WHERE id = ? AND status = 'pending'`,
    [adminId, note, id],
  );

  if (moved.affectedRows === 0) return { ok: false, reason: 'not_pending' };

  const request = await findById(id);
  if (!request) return { ok: false, reason: 'not_pending' };

  const inAt = request.requestedCheckInAt ? new Date(request.requestedCheckInAt) : null;
  const outAt = request.requestedCheckOutAt ? new Date(request.requestedCheckOutAt) : null;

  /*
   * Upsert the day, because it may or may not exist: a forgotten check-OUT leaves a row
   * to patch, a wholly missed day leaves nothing.
   */
  await execute(
    `INSERT INTO hr_attendance
       (user_id, work_date, work_mode, source, status, note)
     SELECT ?, ?, u.work_mode, 'regularisation', 'present', ?
       FROM hr_users u WHERE u.id = ?
     ON DUPLICATE KEY UPDATE source = 'regularisation', note = VALUES(note)`,
    [
      request.userId,
      request.workDate,
      `Regularised: ${request.reason}`.slice(0, 500),
      request.userId,
    ],
  );

  const day = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM hr_attendance WHERE user_id = ? AND work_date = ? LIMIT 1',
    [request.userId, request.workDate],
  );

  /*
   * One corrected session for the day.
   *
   * Existing sessions for that date are cleared first, so approving a correction twice
   * — or correcting a day that already held a partial punch — cannot leave two
   * overlapping sessions that both count toward the total. The request IS the record
   * of what was asked for; the session is simply what it resolved to.
   */
  await execute('DELETE FROM hr_attendance_sessions WHERE attendance_id = ?', [day!.id]);

  await execute(
    `INSERT INTO hr_attendance_sessions
       (attendance_id, user_id, started_at, ended_at, minutes, source)
     VALUES (?, ?, ?, ?,
             CASE WHEN ? IS NULL OR ? IS NULL THEN NULL
                  ELSE GREATEST(0, TIMESTAMPDIFF(MINUTE, ?, ?)) END,
             'regularisation')`,
    [
      day!.id,
      request.userId,
      inAt,
      outAt,
      inAt,
      outAt,
      inAt,
      outAt,
    ],
  );

  /*
   * Re-derive the day from the session just written. Imported lazily because
   * `attendance.service` imports nothing from here — a static import in both
   * directions would be a cycle.
   */
  const { recomputeDayFor } = await import('./attendance.service');
  await recomputeDayFor(request.userId, request.workDate);

  logger.info('HR regularisation approved', { id, userId: request.userId });
  return { ok: true };
}

export async function reject(
  id: number,
  adminId: number | null,
  note: string | null,
): Promise<DecisionResult> {
  const result = await execute(
    `UPDATE hr_regularisations
        SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
      WHERE id = ? AND status = 'pending'`,
    [adminId, note, id],
  );

  if (result.affectedRows === 0) return { ok: false, reason: 'not_pending' };

  logger.info('HR regularisation rejected', { id });
  return { ok: true };
}

export async function pendingCount(): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_regularisations WHERE status = 'pending'`,
  );
  return Number(row?.total ?? 0);
}
