import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import { describeError, logger } from '../../../utils/logger';
import { resolvePage, type Paginated, type Pagination } from '../shared.schema';

/**
 * In-app notifications (spec: Mobile Module 11, Admin Module 10).
 *
 * Stored as well as pushed. A push is fire-and-forget — lost if the handset is off, the
 * token has expired, or the employee swiped the shade away — so the app also has a list
 * to come back to, and the unread count is authoritative here rather than on the device.
 *
 * Delivery to Expo is a separate concern handled by the push service. This module owns
 * the record; `pushed_at` is stamped when the transport accepts it.
 */

export type NotificationKind =
  | 'lead_assigned'
  | 'follow_up_due'
  | 'follow_up_overdue'
  | 'missed_call'
  | 'callback_requested'
  | 'admin_message';

export type QueueNotificationInput = {
  userId: number;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  leadId?: number | null;
  followUpId?: number | null;
};

/**
 * Records a notification.
 *
 * Never throws. A notification is a courtesy attached to something that has already
 * happened — a lead was assigned, a follow-up came due — and failing that operation
 * because the courtesy could not be recorded would be the wrong trade every time.
 */
export async function queueNotification(input: QueueNotificationInput): Promise<void> {
  await execute(
    `INSERT INTO notifications (user_id, kind, title, body, lead_id, follow_up_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.kind,
      input.title.slice(0, 190),
      input.body ? input.body.slice(0, 500) : null,
      input.leadId ?? null,
      input.followUpId ?? null,
    ],
  ).catch((error) =>
    logger.error('Could not queue notification', {
      userId: input.userId,
      kind: input.kind,
      ...describeError(error),
    }),
  );
}

/** Same, for many recipients at once — an admin broadcast to the whole floor. */
export async function queueNotifications(
  inputs: QueueNotificationInput[],
): Promise<void> {
  if (inputs.length === 0) return;

  const placeholders = inputs.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const params: SqlParam[] = [];

  for (const input of inputs) {
    params.push(
      input.userId,
      input.kind,
      input.title.slice(0, 190),
      input.body ? input.body.slice(0, 500) : null,
      input.leadId ?? null,
      input.followUpId ?? null,
    );
  }

  await execute(
    `INSERT INTO notifications (user_id, kind, title, body, lead_id, follow_up_id)
     VALUES ${placeholders}`,
    params,
  ).catch((error) => logger.error('Could not queue notifications', describeError(error)));
}

export interface NotificationRow extends RowDataPacket {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  lead_id: number | null;
  follow_up_id: number | null;
  read_at: Date | null;
  created_at: Date;
}

export type NotificationRecord = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  leadId: number | null;
  followUpId: number | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
};

function toRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    leadId: row.lead_id,
    followUpId: row.follow_up_id,
    isRead: row.read_at !== null,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listNotifications(
  userId: number,
  filters: Pagination & { unreadOnly?: boolean },
): Promise<Paginated<NotificationRecord> & { unread: number }> {
  const conditions = ['user_id = ?'];
  const params: SqlParam[] = [userId];

  if (filters.unreadOnly) conditions.push('read_at IS NULL');

  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM notifications ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  const rows = await query<NotificationRow>(
    `SELECT id, kind, title, body, lead_id, follow_up_id, read_at, created_at
       FROM notifications
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return {
    items: rows.map(toRecord),
    page,
    pageSize,
    total,
    totalPages,
    unread: await countUnread(userId),
  };
}

export async function countUnread(userId: number): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at IS NULL',
    [userId],
  );
  return Number(row?.total ?? 0);
}

/**
 * Marks notifications read.
 *
 * Scoped to `user_id` as well as id, so a client cannot mark someone else's
 * notifications read by guessing an id.
 */
export async function markRead(userId: number, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => '?').join(', ');
  const result = await execute(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
    [userId, ...ids],
  );
  return result.affectedRows;
}

export async function markAllRead(userId: number): Promise<number> {
  const result = await execute(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
    [userId],
  );
  return result.affectedRows;
}

/**
 * Push tokens for the devices one employee is signed in on.
 *
 * An employee may have more than one — a work handset and a tablet — so this returns a
 * list, and the push service fans out to all of them.
 */
export async function pushTokensFor(userId: number): Promise<string[]> {
  const rows = await query<RowDataPacket & { push_token: string }>(
    `SELECT push_token
       FROM mobile_sessions
      WHERE user_id = ?
        AND push_token IS NOT NULL
        AND revoked_at IS NULL
        AND expires_at > NOW()`,
    [userId],
  );
  return rows.map((row) => row.push_token);
}

/** Marks a notification as handed to the push transport. */
export async function markPushed(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  await execute(
    `UPDATE notifications SET pushed_at = NOW() WHERE id IN (${placeholders})`,
    ids,
  ).catch((error) => logger.warn('Could not mark notifications pushed', describeError(error)));
}

/**
 * Notifications not yet handed to the push transport.
 *
 * Read by the delivery worker. Bounded, and oldest first, so a backlog drains in the
 * order it accumulated rather than newest-first — a follow-up reminder from an hour ago
 * is still worth sending, but not ahead of one from two hours ago.
 */
export async function pendingPushes(limit = 100): Promise<
  { id: number; userId: number; title: string; body: string | null; kind: string; leadId: number | null }[]
> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await query<
    RowDataPacket & {
      id: number;
      user_id: number;
      title: string;
      body: string | null;
      kind: string;
      lead_id: number | null;
    }
  >(
    `SELECT id, user_id, title, body, kind, lead_id
       FROM notifications
      WHERE pushed_at IS NULL
        AND created_at > (NOW() - INTERVAL 1 DAY)
      ORDER BY created_at ASC
      LIMIT ${bounded}`,
  );

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    leadId: row.lead_id,
  }));
}
