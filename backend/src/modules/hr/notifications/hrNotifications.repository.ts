import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import { describeError, logger } from '../../../utils/logger';
import type { Page } from '../hr.schema';

/**
 * The HR notification inbox (`hr_notifications`, migration 029).
 *
 * Every module that wants to tell an employee something calls `notifyHr`. The inbox is
 * the record; the app reads it on focus and shows an unread count. There is no push
 * transport yet — a notification here is never lost, it is simply seen when the app is
 * next opened.
 *
 * Kinds in use (free text in the column, listed here so they stay consistent):
 *   leave_submitted, leave_approved, leave_rejected, leave_cancelled
 *   regularisation_approved, regularisation_rejected
 *   request_updated, request_resolved, request_rejected
 *   document_shared, payslip_published, announcement
 *   check_in_reminder, check_out_reminder, missing_punch
 */

export type HrNotificationKind =
  | 'leave_submitted'
  | 'leave_approved'
  | 'leave_rejected'
  | 'leave_cancelled'
  | 'regularisation_approved'
  | 'regularisation_rejected'
  | 'request_updated'
  | 'request_resolved'
  | 'request_rejected'
  | 'document_shared'
  | 'payslip_published'
  | 'announcement'
  | 'check_in_reminder'
  | 'check_out_reminder'
  | 'missing_punch';

export type NotifyInput = {
  userIds: number[];
  kind: HrNotificationKind;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  /**
   * Makes the write idempotent per person: a second notification with the same key for
   * the same user is silently skipped. Use it for anything a scheduler or a retry can
   * produce twice, e.g. `check_in_reminder:2026-10-16`.
   */
  dedupeKey?: string | null;
};

/**
 * Writes one notification per recipient. Returns how many were actually inserted.
 *
 * NEVER throws. A notification is a side effect of something that has already happened
 * — an approval, a payroll run — and failing that action because its notice could not
 * be written would be the wrong way round. Failures are logged.
 *
 * Batched into chunks so an announcement to every employee is a few statements, not
 * one per person.
 */
export async function notifyHr(input: NotifyInput): Promise<number> {
  const recipients = [...new Set(input.userIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (recipients.length === 0) return 0;

  let inserted = 0;
  try {
    for (let start = 0; start < recipients.length; start += 200) {
      const chunk = recipients.slice(start, start + 200);
      const params: SqlParam[] = [];
      const values = chunk.map((userId) => {
        params.push(
          userId,
          input.kind,
          input.title.slice(0, 160),
          input.body ? input.body.slice(0, 500) : null,
          input.entityType ?? null,
          input.entityId ?? null,
          input.dedupeKey ? input.dedupeKey.slice(0, 80) : null,
        );
        return '(?, ?, ?, ?, ?, ?, ?)';
      });

      /*
       * `ON DUPLICATE KEY UPDATE id = id` rather than INSERT IGNORE. Both skip a row
       * that hits the dedupe key, but IGNORE also downgrades every OTHER error — a
       * foreign key failure, a truncation — to a warning, and a notification addressed to
       * a deleted employee would vanish without a trace.
       */
      const result = await execute(
        `INSERT INTO hr_notifications
           (user_id, kind, title, body, entity_type, entity_id, dedupe_key)
         VALUES ${values.join(', ')}
         ON DUPLICATE KEY UPDATE id = id`,
        params,
      );
      // affectedRows counts 1 per insert and 0 per skipped duplicate.
      inserted += result.affectedRows;
    }
  } catch (error) {
    logger.error('Could not write HR notifications', { kind: input.kind, ...describeError(error) });
  }
  return inserted;
}

export type HrNotification = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: number | null;
  readAt: string | null;
  createdAt: string;
};

interface NotificationRow extends RowDataPacket {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: number | null;
  read_at: Date | string | null;
  created_at: Date | string;
}

function toNotification(row: NotificationRow): HrNotification {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id === null ? null : Number(row.entity_id),
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** One page of a person's inbox, newest first. */
export async function listHrNotifications(
  userId: number,
  options: { page: number; pageSize: number; unreadOnly?: boolean },
): Promise<Page<HrNotification>> {
  const where = options.unreadOnly ? 'user_id = ? AND read_at IS NULL' : 'user_id = ?';

  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_notifications WHERE ${where}`,
    [userId],
  );
  const offset = (options.page - 1) * options.pageSize;
  // LIMIT/OFFSET interpolated: Zod-validated positive integers, capped at 100.
  const rows = await query<NotificationRow>(
    `SELECT id, kind, title, body, entity_type, entity_id, read_at, created_at
       FROM hr_notifications WHERE ${where}
      ORDER BY id DESC
      LIMIT ${Number(options.pageSize)} OFFSET ${Number(offset)}`,
    [userId],
  );

  return {
    items: rows.map(toNotification),
    total: Number(count?.total ?? 0),
    page: options.page,
    pageSize: options.pageSize,
  };
}

export async function countUnreadHrNotifications(userId: number): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM hr_notifications WHERE user_id = ? AND read_at IS NULL',
    [userId],
  );
  return Number(row?.total ?? 0);
}

/** The newest few, for the dashboard. */
export async function latestHrNotifications(userId: number, limit = 3): Promise<HrNotification[]> {
  const rows = await query<NotificationRow>(
    `SELECT id, kind, title, body, entity_type, entity_id, read_at, created_at
       FROM hr_notifications WHERE user_id = ?
      ORDER BY id DESC LIMIT ${Math.max(1, Math.min(10, Math.floor(limit)))}`,
    [userId],
  );
  return rows.map(toNotification);
}

/** Marks the given ids read — only ones that belong to `userId`. Returns the count changed. */
export async function markHrNotificationsRead(userId: number, ids: number[]): Promise<number> {
  const clean = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);
  if (clean.length === 0) return 0;
  const result = await execute(
    `UPDATE hr_notifications SET read_at = NOW()
      WHERE user_id = ? AND read_at IS NULL AND id IN (${clean.map(() => '?').join(',')})`,
    [userId, ...clean],
  );
  return result.affectedRows;
}

export async function markAllHrNotificationsRead(userId: number): Promise<number> {
  const result = await execute(
    'UPDATE hr_notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
    [userId],
  );
  return result.affectedRows;
}
