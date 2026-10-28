import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withTransaction } from '../../../db/pool';
import { conflict, notFound } from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { companyToday } from '../calendar/calendar.service';
import { hashHrPassword, revokeAllHrSessions } from '../hrAuth.service';

/**
 * What an administrator does to an employee's ACCOUNT, as opposed to their record:
 * setting a new password, and deleting them.
 *
 * Both lock the employee's row first, so they serialise with each other and with every
 * other per-employee write (leave, record edits) that takes the same lock.
 */

type AccountRow = RowDataPacket & {
  id: number;
  name: string;
  employee_code: string;
  deleted_at: Date | string | null;
};

async function lockAccount(connection: PoolConnection, id: number): Promise<AccountRow | null> {
  const [rows] = await connection.execute<AccountRow[]>(
    'SELECT id, name, employee_code, deleted_at FROM hr_users WHERE id = ? FOR UPDATE',
    [id],
  );
  return rows[0] ?? null;
}

async function run(connection: PoolConnection, sql: string, params: Array<string | number | null>): Promise<number> {
  const [result] = await connection.execute<ResultSetHeader>(sql, params);
  return result.affectedRows;
}

/* -------------------------------------------------------------------------- */
/* Resetting a password                                                        */
/* -------------------------------------------------------------------------- */

export type PasswordResetResult = { name: string; employeeCode: string; sessionsRevoked: number };

/**
 * Replaces the employee's password with one the administrator chose, and signs them out
 * of the HR app on every phone.
 *
 * Signing out is the point of a reset as much as the new password is: whoever knew the
 * old one, or holds a phone that was signed in with it, is out. Access tokens already
 * issued stay valid for their remaining few minutes — the same as switching an account
 * off — because they are stateless and short-lived by design.
 *
 * The administrator hands the new password over in person; it is never emailed. A
 * password in an inbox outlives the reason it was sent.
 */
export async function resetEmployeePassword(id: number, password: string): Promise<PasswordResetResult> {
  // Hashed before the transaction: bcrypt at cost 12 is slow on purpose, and the row
  // lock should not be held for it.
  const hash = await hashHrPassword(password);

  const account = await withTransaction(async (connection) => {
    const row = await lockAccount(connection, id);
    if (!row) throw notFound('Employee not found.');
    if (row.deleted_at) {
      throw conflict(`${row.name} has been deleted, so their password cannot be reset.`, 'employee_deleted');
    }
    await run(connection, 'UPDATE hr_users SET password_hash = ? WHERE id = ?', [hash, id]);
    return row;
  });

  const sessionsRevoked = await revokeAllHrSessions(id);
  logger.info('HR password reset by an administrator', { id, sessionsRevoked });
  return { name: account.name, employeeCode: account.employee_code, sessionsRevoked };
}

/* -------------------------------------------------------------------------- */
/* Deleting an employee                                                        */
/* -------------------------------------------------------------------------- */

export type DeleteResult = {
  name: string;
  employeeCode: string;
  /** True when they were already deleted; nothing was changed this time. */
  alreadyDeleted: boolean;
  leaveCancelled: number;
  correctionsClosed: number;
  requestsClosed: number;
  /** People who reported to them, now with no manager (HR decides for them). */
  reportsUnassigned: number;
  /** Payslips taken out of pay periods not yet approved. */
  payslipsRemoved: number;
  sessionsRevoked: number;
};

const CLOSED_NOTE = 'Closed because the employee was deleted.';

/**
 * Deletes an employee — a SOFT delete (migration 038): the row stays, so everything
 * already recorded about them keeps its name and approved payroll stays reconcilable.
 *
 * The user's rule (2026-10-28): a deleted employee must never be in the current or any
 * upcoming payroll, "and all". So, in one transaction:
 *
 *   - the account is marked deleted and switched off;
 *   - their pending leave, and approved leave that has not started, is cancelled;
 *   - their pending attendance corrections and open HR requests are closed, so no
 *     approver's queue holds work for somebody who is gone;
 *   - anybody who reported to them is left without a manager, so their requests reach
 *     HR instead of an account nobody can sign in to;
 *   - their payslip is removed from every pay period NOT YET APPROVED, with that period's
 *     totals recomputed, and so are any "pay in full" decision and their line in the
 *     period's "not included" list. Approved periods are never touched.
 *
 * Then every session is revoked. Calling it again for a deleted employee changes nothing.
 */
export async function deleteEmployee(id: number, actorName: string | null): Promise<DeleteResult> {
  const today = companyToday();
  const by = actorName ? actorName.slice(0, 120) : null;

  const outcome = await withTransaction(async (connection) => {
    const row = await lockAccount(connection, id);
    if (!row) throw notFound('Employee not found.');

    const result: DeleteResult = {
      name: row.name,
      employeeCode: row.employee_code,
      alreadyDeleted: row.deleted_at !== null,
      leaveCancelled: 0,
      correctionsClosed: 0,
      requestsClosed: 0,
      reportsUnassigned: 0,
      payslipsRemoved: 0,
      sessionsRevoked: 0,
    };
    if (result.alreadyDeleted) return result;

    await run(
      connection,
      'UPDATE hr_users SET deleted_at = NOW(), deleted_by_name = ?, is_active = 0 WHERE id = ?',
      [by, id],
    );

    result.leaveCancelled = await run(
      connection,
      `UPDATE hr_leave_requests
          SET status = 'cancelled', cancelled_at = NOW(), review_note = COALESCE(review_note, ?)
        WHERE user_id = ? AND (status = 'pending' OR (status = 'approved' AND start_date > ?))`,
      [CLOSED_NOTE, id, today],
    );

    result.correctionsClosed = await run(
      connection,
      `UPDATE hr_regularisations
          SET status = 'rejected', reviewed_at = NOW(), reviewer_type = 'admin', reviewer_name = ?,
              review_note = ?
        WHERE user_id = ? AND status = 'pending'`,
      [by, CLOSED_NOTE, id],
    );

    result.requestsClosed = await run(
      connection,
      `UPDATE hr_requests
          SET status = 'cancelled', resolved_at = NOW(), resolved_by_name = ?, resolution_note = ?,
              last_activity_at = NOW()
        WHERE user_id = ? AND status IN ('open','in_progress')`,
      [by, CLOSED_NOTE, id],
    );

    result.reportsUnassigned = await run(connection, 'UPDATE hr_users SET manager_id = NULL WHERE manager_id = ?', [id]);

    result.payslipsRemoved = await removeFromOpenPayroll(connection, id);
    return result;
  });

  if (!outcome.alreadyDeleted) {
    outcome.sessionsRevoked = await revokeAllHrSessions(id);
    logger.info('HR employee deleted', { id, ...outcome });
  }
  return outcome;
}

/**
 * Takes the employee out of every pay period that is not approved yet. Lines go with the
 * payslip (ON DELETE CASCADE). Each touched period's totals are recomputed from the
 * payslips left, the same sums a calculation writes, so the period reads as if it had been
 * calculated without them; its next recalculation leaves them out anyway, because
 * `payrollCandidates` no longer finds them.
 */
async function removeFromOpenPayroll(connection: PoolConnection, userId: number): Promise<number> {
  const [runs] = await connection.execute<Array<RowDataPacket & { id: number; exclusions: unknown }>>(
    `SELECT id, exclusions FROM hr_payroll_runs WHERE status IN ('draft','processed') FOR UPDATE`,
  );
  if (runs.length === 0) return 0;

  let removed = 0;
  for (const payrollRun of runs) {
    const slips = await run(connection, 'DELETE FROM hr_payslips WHERE run_id = ? AND user_id = ?', [payrollRun.id, userId]);
    await run(connection, 'DELETE FROM hr_payroll_full_pay WHERE run_id = ? AND user_id = ?', [payrollRun.id, userId]);

    const exclusions = parseExclusions(payrollRun.exclusions);
    const kept = exclusions.filter((entry) => Number(entry.userId) !== userId);
    if (kept.length !== exclusions.length) {
      await run(connection, 'UPDATE hr_payroll_runs SET exclusions = ? WHERE id = ?', [JSON.stringify(kept), payrollRun.id]);
    }

    if (slips > 0) {
      removed += slips;
      await run(
        connection,
        `UPDATE hr_payroll_runs r
            SET r.employee_count   = (SELECT COUNT(*) FROM hr_payslips p WHERE p.run_id = r.id),
                r.total_gross      = (SELECT COALESCE(SUM(p.gross_earnings), 0) FROM hr_payslips p WHERE p.run_id = r.id),
                r.total_deductions = (SELECT COALESCE(SUM(p.total_deductions), 0) FROM hr_payslips p WHERE p.run_id = r.id),
                r.total_net        = (SELECT COALESCE(SUM(p.net_pay), 0) FROM hr_payslips p WHERE p.run_id = r.id)
          WHERE r.id = ?`,
        [payrollRun.id],
      );
    }
  }
  return removed;
}

function parseExclusions(value: unknown): Array<{ userId: unknown }> {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? (list as Array<{ userId: unknown }>) : [];
}
