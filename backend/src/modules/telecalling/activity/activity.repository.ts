import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import { describeError, logger } from '../../../utils/logger';
import { actorLabel, type Actor } from '../actor';
import {
  likeTerm,
  resolvePage,
  type ActivityType,
  type Paginated,
  type Pagination,
} from '../shared.schema';

/**
 * Writes and reads for the two history tables.
 *
 * `lead_activities` is the story of one customer relationship, read on every lead-detail
 * open. `audit_logs` is the record of what people did to the system, read rarely and
 * never shown to a telecaller. See migration 009 for why they are not one table.
 */

/* -------------------------------------------------------------------------- */
/* Lead activity                                                               */
/* -------------------------------------------------------------------------- */

export type ActivityInput = {
  leadId: number;
  userId: number | null;
  type: ActivityType;
  summary: string;
  meta?: Record<string, unknown> | null;
};

const INSERT_ACTIVITY = `
  INSERT INTO lead_activities (lead_id, user_id, type, summary, meta)
  VALUES (?, ?, ?, ?, ?)
`;

function activityParams(input: ActivityInput): SqlParam[] {
  return [
    input.leadId,
    input.userId,
    input.type,
    // The column is VARCHAR(255) and a summary is composed from user-supplied names,
    // so truncate rather than let a long customer name fail the insert — and with it
    // the change the activity was describing.
    input.summary.slice(0, 255),
    input.meta ? JSON.stringify(input.meta) : null,
  ];
}

/**
 * Records lead activity **inside an existing transaction**.
 *
 * This is the form to prefer. An activity row that can be missing while the change it
 * describes succeeded is worse than having no timeline at all, because it makes the
 * timeline untrustworthy — and a timeline nobody trusts gets ignored precisely when it
 * matters. So the write shares the caller's transaction and fails it on error.
 */
export async function recordActivityTx(
  connection: PoolConnection,
  input: ActivityInput,
): Promise<void> {
  await connection.execute(INSERT_ACTIVITY, activityParams(input));
}

/**
 * Records lead activity outside a transaction.
 *
 * Only for changes that are a single statement anyway, where there is no transaction to
 * join. Failure is logged and swallowed: at that point the change has already
 * committed, and throwing would report a failure for work that succeeded.
 */
export async function recordActivity(input: ActivityInput): Promise<void> {
  await execute(INSERT_ACTIVITY, activityParams(input)).catch((error) =>
    logger.error('Could not record lead activity', {
      leadId: input.leadId,
      type: input.type,
      ...describeError(error),
    }),
  );
}

export interface ActivityRow extends RowDataPacket {
  id: number;
  lead_id: number;
  user_id: number | null;
  user_name: string | null;
  type: string;
  summary: string;
  meta: unknown;
  created_at: Date;
}

export type ActivityRecord = {
  id: number;
  leadId: number;
  userId: number | null;
  userName: string | null;
  type: string;
  summary: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

/**
 * MySQL returns a JSON column already parsed; MariaDB returns the raw string, because
 * there JSON is an alias for LONGTEXT. Handle both so the API response does not depend
 * on which engine the deployment runs.
 */
function parseMeta(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toActivityRecord(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    userId: row.user_id,
    userName: row.user_name,
    type: row.type,
    summary: row.summary,
    meta: parseMeta(row.meta),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const ACTIVITY_SELECT = `
  SELECT a.id, a.lead_id, a.user_id, u.name AS user_name, a.type, a.summary, a.meta, a.created_at
    FROM lead_activities a
    LEFT JOIN telecaller_users u ON u.id = a.user_id
`;

/** One lead's timeline, newest first. */
export async function listLeadActivity(
  leadId: number,
  limit = 100,
): Promise<ActivityRecord[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await query<ActivityRow>(
    `${ACTIVITY_SELECT} WHERE a.lead_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ${bounded}`,
    [leadId],
  );
  return rows.map(toActivityRecord);
}

/** One employee's recent activity, for the admin employee-detail screen. */
export async function listEmployeeActivity(
  userId: number,
  limit = 100,
): Promise<ActivityRecord[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await query<ActivityRow>(
    `${ACTIVITY_SELECT} WHERE a.user_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ${bounded}`,
    [userId],
  );
  return rows.map(toActivityRecord);
}

/* -------------------------------------------------------------------------- */
/* Audit log                                                                   */
/* -------------------------------------------------------------------------- */

export type AuditInput = {
  actor: Actor | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  summary: string;
  meta?: Record<string, unknown> | null;
  ipAddress?: string | null;
};

/**
 * Records a system action.
 *
 * Never throws. An audit write failing must not roll back the operation it describes —
 * refusing to deactivate an employee because the log was unavailable would be a strictly
 * worse outcome than an incomplete log. The failure is logged at error level so it is
 * visible rather than silent.
 *
 * `actorLabel` denormalises the actor's name and email into the row on purpose: the
 * answer to "who did this" must survive the deletion of the account that did it.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  const actorType = input.actor === null ? 'system' : input.actor.via === 'cookie' ? 'admin' : 'employee';

  await execute(
    `INSERT INTO audit_logs
       (actor_type, actor_id, actor_label, action, entity_type, entity_id, summary, meta, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actorType,
      input.actor?.id ?? null,
      input.actor ? actorLabel(input.actor) : null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.summary.slice(0, 255),
      input.meta ? JSON.stringify(input.meta) : null,
      input.ipAddress ?? null,
    ],
  ).catch((error) =>
    logger.error('Could not write audit log', {
      action: input.action,
      entityType: input.entityType,
      ...describeError(error),
    }),
  );
}

export interface AuditRow extends RowDataPacket {
  id: number;
  actor_type: string;
  actor_id: number | null;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: number | null;
  summary: string;
  meta: unknown;
  ip_address: string | null;
  created_at: Date;
}

export type AuditRecord = {
  id: number;
  actorType: string;
  actorId: number | null;
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: number | null;
  summary: string;
  meta: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
};

function toAuditRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    meta: parseMeta(row.meta),
    ipAddress: row.ip_address,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export type AuditFilters = Pagination & {
  action?: string;
  entityType?: string;
  actorId?: number;
  q?: string;
  from?: string;
  to?: string;
};

export async function listAuditLogs(filters: AuditFilters): Promise<Paginated<AuditRecord>> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }
  if (filters.entityType) {
    conditions.push('entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.actorId) {
    conditions.push('actor_id = ?');
    params.push(filters.actorId);
  }
  if (filters.from) {
    conditions.push('created_at >= ?');
    params.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    conditions.push('created_at <= ?');
    params.push(`${filters.to} 23:59:59`);
  }
  if (filters.q) {
    conditions.push('(summary LIKE ? OR actor_label LIKE ?)');
    const term = likeTerm(filters.q);
    params.push(term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM audit_logs ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  const rows = await query<AuditRow>(
    `SELECT id, actor_type, actor_id, actor_label, action, entity_type, entity_id,
            summary, meta, ip_address, created_at
       FROM audit_logs
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toAuditRecord), page, pageSize, total, totalPages };
}
