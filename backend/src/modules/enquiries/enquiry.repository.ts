import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../db/pool';
import type { EnquiryStatus, ListQuery } from './enquiry.schema';

/**
 * Data access for enquiries.
 *
 * Every value is bound as a parameter. The only values interpolated into SQL are LIMIT
 * and OFFSET, which are integers validated by `listQuerySchema` before they get here —
 * MySQL prepared statements do not accept placeholders there reliably.
 */

export interface EnquiryRow extends RowDataPacket {
  id: number;
  reference: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  interested_in: string;
  message: string;
  source: string;
  status: EnquiryStatus;
  created_at: Date;
  updated_at: Date;
}

export type EnquiryRecord = {
  id: number;
  reference: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  interestedIn: string;
  message: string;
  source: string;
  status: EnquiryStatus;
  createdAt: string;
  updatedAt: string;
};

export function toRecord(row: EnquiryRow): EnquiryRecord {
  return {
    id: row.id,
    reference: row.reference,
    name: row.name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    interestedIn: row.interested_in,
    message: row.message,
    source: row.source,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export type CreateEnquiryData = {
  reference: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  interestedIn: string;
  message: string;
  source: string;
  ipAddress: string | null;
  userAgent: string | null;
};

export async function insertEnquiry(data: CreateEnquiryData): Promise<number> {
  const result = await execute(
    `INSERT INTO enquiries
       (reference, name, email, phone, company, interested_in, message, source, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.reference,
      data.name,
      data.email,
      data.phone,
      data.company,
      data.interestedIn,
      data.message,
      data.source,
      data.ipAddress,
      data.userAgent,
    ],
  );

  return result.insertId;
}

export async function markNotifications(
  id: number,
  flags: { notificationSent?: boolean; autoReplySent?: boolean },
): Promise<void> {
  const assignments: string[] = [];
  const params: SqlParam[] = [];

  if (flags.notificationSent !== undefined) {
    assignments.push('notification_sent = ?');
    params.push(flags.notificationSent ? 1 : 0);
  }
  if (flags.autoReplySent !== undefined) {
    assignments.push('autoreply_sent = ?');
    params.push(flags.autoReplySent ? 1 : 0);
  }
  if (assignments.length === 0) return;

  params.push(id);
  await execute(`UPDATE enquiries SET ${assignments.join(', ')} WHERE id = ?`, params);
}

/** Escapes LIKE wildcards so a search for "50%" does not match everything. */
function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export type PaginatedEnquiries = {
  items: EnquiryRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export async function listEnquiries(filters: ListQuery): Promise<PaginatedEnquiries> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  if (filters.q) {
    conditions.push(
      '(name LIKE ? OR email LIKE ? OR phone LIKE ? OR reference LIKE ? OR company LIKE ?)',
    );
    const term = likeTerm(filters.q);
    params.push(term, term, term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM enquiries ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);

  const pageSize = Math.min(Math.max(Math.trunc(filters.pageSize), 1), 100);
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(Math.trunc(filters.page), 1), totalPages);
  const offset = (page - 1) * pageSize;

  const rows = await query<EnquiryRow>(
    `SELECT id, reference, name, email, phone, company, interested_in, message, source, status,
            created_at, updated_at
       FROM enquiries
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toRecord), page, pageSize, total, totalPages };
}

export async function findEnquiry(id: number): Promise<EnquiryRecord | null> {
  const row = await queryOne<EnquiryRow>(
    `SELECT id, reference, name, email, phone, company, interested_in, message, source, status,
            created_at, updated_at
       FROM enquiries WHERE id = ? LIMIT 1`,
    [id],
  );
  return row ? toRecord(row) : null;
}

export async function updateEnquiryStatus(
  id: number,
  status: EnquiryStatus,
): Promise<EnquiryRecord | null> {
  const result = await execute('UPDATE enquiries SET status = ? WHERE id = ?', [status, id]);
  if (result.affectedRows === 0) return null;
  return findEnquiry(id);
}

/** Recent submissions from one IP — a cheap duplicate/flood check beyond rate limiting. */
export async function countRecentByIp(ipAddress: string, minutes: number): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM enquiries WHERE ip_address = ? AND created_at > (NOW() - INTERVAL ? MINUTE)',
    [ipAddress, minutes],
  );
  return Number(row?.total ?? 0);
}
