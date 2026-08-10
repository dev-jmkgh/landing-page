import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../db/pool';
import type { ListQuery } from '../enquiries/enquiry.schema';
import type { ApplicationStatus } from './application.schema';

export interface ApplicationRow extends RowDataPacket {
  id: number;
  reference: string;
  full_name: string;
  email: string;
  phone: string;
  position: string;
  message: string | null;
  linkedin_url: string | null;
  portfolio_url: string | null;
  experience: string | null;
  location: string | null;
  resume_filename: string | null;
  resume_original_name: string | null;
  resume_mime: string | null;
  resume_size: number | null;
  status: ApplicationStatus;
  created_at: Date;
  updated_at: Date;
}

export type ApplicationRecord = {
  id: number;
  reference: string;
  fullName: string;
  email: string;
  phone: string;
  position: string;
  message: string | null;
  linkedinUrl: string | null;
  portfolioUrl: string | null;
  experience: string | null;
  location: string | null;
  resumeFilename: string | null;
  resumeOriginalName: string | null;
  resumeMime: string | null;
  resumeSize: number | null;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt: string;
};

export function toRecord(row: ApplicationRow): ApplicationRecord {
  return {
    id: row.id,
    reference: row.reference,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    position: row.position,
    message: row.message,
    linkedinUrl: row.linkedin_url,
    portfolioUrl: row.portfolio_url,
    experience: row.experience,
    location: row.location,
    resumeFilename: row.resume_filename,
    resumeOriginalName: row.resume_original_name,
    resumeMime: row.resume_mime,
    resumeSize: row.resume_size,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export type CreateApplicationData = {
  reference: string;
  fullName: string;
  email: string;
  phone: string;
  position: string;
  message: string | null;
  linkedinUrl: string | null;
  portfolioUrl: string | null;
  experience: string | null;
  location: string | null;
  resumeFilename: string | null;
  resumeOriginalName: string | null;
  resumeMime: string | null;
  resumeSize: number | null;
  ipAddress: string | null;
  userAgent: string | null;
};

export async function insertApplication(data: CreateApplicationData): Promise<number> {
  const result = await execute(
    `INSERT INTO job_applications
       (reference, full_name, email, phone, position, message,
        linkedin_url, portfolio_url, experience, location,
        resume_filename, resume_original_name, resume_mime, resume_size,
        ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.reference,
      data.fullName,
      data.email,
      data.phone,
      data.position,
      data.message,
      data.linkedinUrl,
      data.portfolioUrl,
      data.experience,
      data.location,
      data.resumeFilename,
      data.resumeOriginalName,
      data.resumeMime,
      data.resumeSize,
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
  await execute(`UPDATE job_applications SET ${assignments.join(', ')} WHERE id = ?`, params);
}

function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export type PaginatedApplications = {
  items: ApplicationRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const SELECT_COLUMNS = `id, reference, full_name, email, phone, position, message,
        linkedin_url, portfolio_url, experience, location,
        resume_filename, resume_original_name, resume_mime, resume_size, status,
        created_at, updated_at`;

export async function listApplications(filters: ListQuery): Promise<PaginatedApplications> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  if (filters.q) {
    conditions.push(
      '(full_name LIKE ? OR email LIKE ? OR phone LIKE ? OR reference LIKE ? OR position LIKE ?)',
    );
    const term = likeTerm(filters.q);
    params.push(term, term, term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM job_applications ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);

  // Integers validated by listQuerySchema — safe to inline, unlike any user string.
  const pageSize = Math.min(Math.max(Math.trunc(filters.pageSize), 1), 100);
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(Math.trunc(filters.page), 1), totalPages);
  const offset = (page - 1) * pageSize;

  const rows = await query<ApplicationRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM job_applications
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toRecord), page, pageSize, total, totalPages };
}

export async function findApplication(id: number): Promise<ApplicationRecord | null> {
  const row = await queryOne<ApplicationRow>(
    `SELECT ${SELECT_COLUMNS} FROM job_applications WHERE id = ? LIMIT 1`,
    [id],
  );
  return row ? toRecord(row) : null;
}

export async function updateApplicationStatus(
  id: number,
  status: ApplicationStatus,
): Promise<ApplicationRecord | null> {
  const result = await execute('UPDATE job_applications SET status = ? WHERE id = ?', [status, id]);
  if (result.affectedRows === 0) return null;
  return findApplication(id);
}

export async function countRecentByIp(ipAddress: string, minutes: number): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM job_applications WHERE ip_address = ? AND created_at > (NOW() - INTERVAL ? MINUTE)',
    [ipAddress, minutes],
  );
  return Number(row?.total ?? 0);
}
