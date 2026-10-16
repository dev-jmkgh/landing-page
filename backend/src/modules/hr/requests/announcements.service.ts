import { query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import { badRequest } from '../../../utils/httpError';
import { notifyHr, type NotifyInput } from '../notifications/hrNotifications.repository';
import type { BroadcastInput } from './requests.schema';

/**
 * Telling many employees at once: announcements, and company-wide documents.
 *
 * "Everyone" is every APPROVED, ACTIVE account that has not exited — the people who can
 * sign in and still work here. A pending registration is not an employee yet, a
 * deactivated account cannot read its inbox, and somebody whose employment has ended
 * should not be told about next month's policy.
 */

const RECIPIENT_BATCH = 500;

/**
 * Notifies every current employee (optionally one department), a batch at a time.
 * Returns how many notifications were written.
 *
 * Keyset-paged on the primary key rather than loading every id at once, so a company
 * of any size is a bounded series of reads, each handed to `notifyHr` — which itself
 * writes in chunks and never throws.
 */
export async function notifyCurrentEmployees(
  input: Omit<NotifyInput, 'userIds'> & { departmentId?: number | null },
): Promise<number> {
  const { departmentId, ...notification } = input;
  let afterId = 0;
  let written = 0;

  for (;;) {
    const params: SqlParam[] = [afterId];
    let departmentCondition = '';
    if (departmentId) {
      departmentCondition = 'AND department_id = ?';
      params.push(departmentId);
    }

    // LIMIT interpolated: a constant.
    const rows = await query<RowDataPacket & { id: number }>(
      `SELECT id FROM hr_users
        WHERE id > ?
          AND approval_status = 'approved' AND is_active = 1
          AND employment_status <> 'exited'
          ${departmentCondition}
        ORDER BY id ASC
        LIMIT ${RECIPIENT_BATCH}`,
      params,
    );
    if (rows.length === 0) break;

    written += await notifyHr({ ...notification, userIds: rows.map((row) => Number(row.id)) });

    const last = rows[rows.length - 1];
    if (!last || rows.length < RECIPIENT_BATCH) break;
    afterId = Number(last.id);
  }

  return written;
}

/** Sends an announcement. Returns how many employees it reached. */
export async function broadcastAnnouncement(
  input: BroadcastInput,
): Promise<{ recipients: number; departmentName: string | null }> {
  let departmentName: string | null = null;

  if (input.departmentId) {
    const department = await queryOne<RowDataPacket & { name: string }>(
      'SELECT name FROM hr_departments WHERE id = ? LIMIT 1',
      [input.departmentId],
    );
    if (!department) {
      throw badRequest('That department does not exist.', { departmentId: 'Choose a department from the list.' });
    }
    departmentName = department.name;
  }

  const recipients = await notifyCurrentEmployees({
    kind: 'announcement',
    title: input.title,
    body: input.body,
    entityType: 'announcement',
    departmentId: input.departmentId ?? null,
  });

  return { recipients, departmentName };
}
