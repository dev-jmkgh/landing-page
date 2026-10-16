import type { PoolConnection } from 'mysql2/promise';
import {
  execute,
  query,
  queryOne,
  type ResultSetHeader,
  type RowDataPacket,
  type SqlParam,
} from '../../../db/pool';
import type { Page } from '../hr.schema';
import type { HrDocument, HrDocumentCategory, HrDocumentScope } from './requests.schema';

/**
 * SQL for `hr_documents` (migration 029).
 *
 * `deleted_at IS NULL` is in EVERY read the app or the download paths make. A removed
 * document stays as a row — the record that somebody once had access — but nothing
 * serves it, lists it or links to it again.
 */

interface DocumentRow extends RowDataPacket {
  id: number;
  user_id: number | null;
  employee_name: string | null;
  title: string;
  category: HrDocumentCategory;
  storage_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  request_id: number | null;
  uploaded_by_name: string | null;
  created_at: Date | string;
  deleted_at: Date | string | null;
}

/** The record plus what only the server needs: where the bytes are. Never sent out. */
export type StoredDocument = HrDocument & { storageKey: string; deletedAt: string | null };

function toDocument(row: DocumentRow): HrDocument {
  return {
    id: row.id,
    userId: row.user_id,
    employeeName: row.user_id === null ? null : row.employee_name,
    title: row.title,
    category: row.category,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    requestId: row.request_id,
    uploadedByName: row.uploaded_by_name,
    createdAt: new Date(row.created_at).toISOString(),
    scope: row.user_id === null ? 'company' : 'personal',
  };
}

function toStored(row: DocumentRow): StoredDocument {
  return {
    ...toDocument(row),
    storageKey: row.storage_key,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
  };
}

const DOCUMENT_SELECT = `
  SELECT d.id, d.user_id, u.name AS employee_name, d.title, d.category, d.storage_key,
         d.original_name, d.mime_type, d.size_bytes, d.request_id, d.uploaded_by_name,
         d.created_at, d.deleted_at
    FROM hr_documents d
    LEFT JOIN hr_users u ON u.id = d.user_id
`;

export type DocumentListFilters = {
  /**
   * The employee reading: restricts to what they may see, company-wide plus their own.
   * Set by every HR-app read; absent only for the admin portal.
   */
  viewerId?: number;
  scope: HrDocumentScope;
  /**
   * Admin: one employee. With scope `personal` that employee's own documents; with
   * `all`, everything that employee can see (theirs plus company-wide); ignored for
   * `company`.
   */
  userId?: number;
  requestId?: number;
  q?: string;
  page: number;
  pageSize: number;
};

/** One page, newest first. Never includes removed documents. */
export async function listDocuments(filters: DocumentListFilters): Promise<Page<HrDocument>> {
  const conditions: string[] = ['d.deleted_at IS NULL'];
  const params: SqlParam[] = [];

  if (filters.viewerId !== undefined) {
    conditions.push('(d.user_id IS NULL OR d.user_id = ?)');
    params.push(filters.viewerId);
  }

  if (filters.scope === 'company') {
    conditions.push('d.user_id IS NULL');
  } else if (filters.scope === 'personal') {
    conditions.push('d.user_id IS NOT NULL');
    if (filters.userId !== undefined) {
      conditions.push('d.user_id = ?');
      params.push(filters.userId);
    }
  } else if (filters.userId !== undefined) {
    conditions.push('(d.user_id IS NULL OR d.user_id = ?)');
    params.push(filters.userId);
  }

  if (filters.requestId !== undefined) {
    conditions.push('d.request_id = ?');
    params.push(filters.requestId);
  }

  if (filters.q) {
    const term = `%${filters.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push('(d.title LIKE ? OR d.original_name LIKE ? OR u.name LIKE ? OR u.employee_code LIKE ?)');
    params.push(term, term, term, term);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const count = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM hr_documents d LEFT JOIN hr_users u ON u.id = d.user_id ${where}`,
    params,
  );
  // LIMIT/OFFSET interpolated: Zod-validated positive integers, pageSize capped at 100.
  const rows = await query<DocumentRow>(
    `${DOCUMENT_SELECT} ${where}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${Number(filters.pageSize)} OFFSET ${Number((filters.page - 1) * filters.pageSize)}`,
    params,
  );

  return {
    items: rows.map(toDocument),
    total: Number(count?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/** A document that has not been removed. Admin use: no ownership filter. */
export async function findLiveDocument(id: number): Promise<StoredDocument | null> {
  const row = await queryOne<DocumentRow>(
    `${DOCUMENT_SELECT} WHERE d.id = ? AND d.deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return row ? toStored(row) : null;
}

/**
 * A document the employee may have: not removed, and company-wide or theirs. The one
 * query behind both "mint a link" and "follow a link", so the two cannot disagree.
 */
export async function findDocumentForEmployee(id: number, userId: number): Promise<StoredDocument | null> {
  const row = await queryOne<DocumentRow>(
    `${DOCUMENT_SELECT}
      WHERE d.id = ? AND d.deleted_at IS NULL AND (d.user_id IS NULL OR d.user_id = ?)
      LIMIT 1`,
    [id, userId],
  );
  return row ? toStored(row) : null;
}

export async function findDocumentById(id: number): Promise<StoredDocument | null> {
  const row = await queryOne<DocumentRow>(`${DOCUMENT_SELECT} WHERE d.id = ? LIMIT 1`, [id]);
  return row ? toStored(row) : null;
}

export async function insertDocumentTx(
  connection: PoolConnection,
  input: {
    userId: number | null;
    title: string;
    category: HrDocumentCategory;
    storageKey: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    requestId: number | null;
    uploadedBy: number;
    uploadedByName: string;
  },
): Promise<number> {
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO hr_documents
       (user_id, title, category, storage_key, original_name, mime_type, size_bytes,
        request_id, uploaded_by, uploaded_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.title,
      input.category,
      input.storageKey,
      input.originalName.slice(0, 255),
      input.mimeType,
      input.sizeBytes,
      input.requestId,
      input.uploadedBy,
      input.uploadedByName.slice(0, 120),
    ],
  );
  return result.insertId;
}

/** Soft delete, guarded so a second click reports "already removed". */
export async function softDeleteDocument(id: number): Promise<boolean> {
  const result = await execute(
    'UPDATE hr_documents SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
  return result.affectedRows > 0;
}
