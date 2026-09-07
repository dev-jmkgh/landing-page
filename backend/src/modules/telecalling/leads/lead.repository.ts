import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import type { OwnershipScope } from '../actor';
import {
  likeTerm,
  phoneMatchKey,
  resolvePage,
  type LeadStatus,
  type Paginated,
} from '../shared.schema';
import type { LeadListQuery, LeadSort, UpdateLeadInput } from './lead.schema';

/**
 * Data access for leads.
 *
 * Every read that a telecaller can reach takes an `OwnershipScope`. That is a required
 * parameter, not an optional filter: a telecaller may only see leads assigned to them,
 * and expressing that as part of the query — rather than as a check in the route — means
 * a new endpoint cannot forget it and compile anyway.
 */

export interface LeadRow extends RowDataPacket {
  id: number;
  reference: string;
  customer_name: string;
  phone: string;
  alternate_phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  source: string;
  product_interest: string | null;
  status: LeadStatus;
  assigned_to: number | null;
  assigned_to_name: string | null;
  assigned_at: Date | null;
  created_by: number | null;
  enquiry_id: number | null;
  attachment_key: string | null;
  attachment_mime: string | null;
  summary_note: string | null;
  last_contacted_at: Date | null;
  next_follow_up_at: Date | null;
  converted_at: Date | null;
  is_archived: number;
  created_at: Date;
  updated_at: Date;
}

export type LeadRecord = {
  id: number;
  reference: string;
  customerName: string;
  phone: string;
  alternatePhone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  source: string;
  productInterest: string | null;
  status: LeadStatus;
  assignedTo: number | null;
  assignedToName: string | null;
  assignedAt: string | null;
  createdBy: number | null;
  enquiryId: number | null;
  /** True when a photo of a paper lead is attached. The key itself is not exposed. */
  hasAttachment: boolean;
  summaryNote: string | null;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  convertedAt: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
};

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);

/**
 * `attachment_key` is deliberately not in the record.
 *
 * It is a storage key, and handing it to a client invites the client to build a URL from
 * it. Attachments are served only through the authenticated route that presigns a
 * short-lived URL, exactly as resumes are.
 */
export function toLeadRecord(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    reference: row.reference,
    customerName: row.customer_name,
    phone: row.phone,
    alternatePhone: row.alternate_phone,
    email: row.email,
    address: row.address,
    city: row.city,
    source: row.source,
    productInterest: row.product_interest,
    status: row.status,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    assignedAt: iso(row.assigned_at),
    createdBy: row.created_by,
    enquiryId: row.enquiry_id,
    hasAttachment: Boolean(row.attachment_key),
    summaryNote: row.summary_note,
    lastContactedAt: iso(row.last_contacted_at),
    nextFollowUpAt: iso(row.next_follow_up_at),
    convertedAt: iso(row.converted_at),
    isArchived: row.is_archived === 1,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const LEAD_SELECT = `
  SELECT l.id, l.reference, l.customer_name, l.phone, l.alternate_phone, l.email,
         l.address, l.city, l.source, l.product_interest, l.status,
         l.assigned_to, u.name AS assigned_to_name, l.assigned_at, l.created_by,
         l.enquiry_id, l.attachment_key, l.attachment_mime, l.summary_note,
         l.last_contacted_at, l.next_follow_up_at, l.converted_at, l.is_archived,
         l.created_at, l.updated_at
    FROM leads l
    LEFT JOIN telecaller_users u ON u.id = l.assigned_to
`;

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One lead, subject to ownership.
 *
 * Returns null both when the lead does not exist and when the caller may not see it.
 * The route turns that into a 404 for both cases on purpose: a 403 would confirm that a
 * lead with that id exists and belongs to someone else, which is exactly what an
 * employee probing ids is trying to learn.
 */
export async function findLead(id: number, scope: OwnershipScope): Promise<LeadRecord | null> {
  const params: SqlParam[] = [id];
  let where = 'WHERE l.id = ?';

  if (scope !== null) {
    where += ' AND l.assigned_to = ?';
    params.push(scope);
  }

  const row = await queryOne<LeadRow>(`${LEAD_SELECT} ${where} LIMIT 1`, params);
  return row ? toLeadRecord(row) : null;
}

/** The attachment key, for the authenticated download route only. */
export async function findLeadAttachment(
  id: number,
  scope: OwnershipScope,
): Promise<{ key: string; mime: string | null; reference: string } | null> {
  const params: SqlParam[] = [id];
  let where = 'WHERE id = ? AND attachment_key IS NOT NULL';

  if (scope !== null) {
    where += ' AND assigned_to = ?';
    params.push(scope);
  }

  const row = await queryOne<
    RowDataPacket & { attachment_key: string; attachment_mime: string | null; reference: string }
  >(`SELECT attachment_key, attachment_mime, reference FROM leads ${where} LIMIT 1`, params);

  return row ? { key: row.attachment_key, mime: row.attachment_mime, reference: row.reference } : null;
}

/** ORDER BY fragments. A closed set, because this is interpolated rather than bound. */
const SORT_CLAUSES: Record<LeadSort, string> = {
  recent: 'l.created_at DESC, l.id DESC',
  oldest: 'l.created_at ASC, l.id ASC',
  name: 'l.customer_name ASC, l.id ASC',
  /**
   * Soonest follow-up first, and leads with no follow-up last rather than first — MySQL
   * sorts NULL before every value, which would otherwise bury the work that is actually
   * due under every lead that has none.
   */
  follow_up: 'l.next_follow_up_at IS NULL, l.next_follow_up_at ASC, l.id ASC',
  last_contacted: 'l.last_contacted_at IS NULL, l.last_contacted_at DESC, l.id DESC',
  /** The "who have I been ignoring" ordering: never contacted first, then longest ago. */
  never_contacted: 'l.last_contacted_at IS NOT NULL, l.last_contacted_at ASC, l.created_at ASC',
};

function buildLeadFilters(
  filters: LeadListQuery,
  scope: OwnershipScope,
): { where: string; params: SqlParam[] } {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  conditions.push('l.is_archived = ?');
  params.push(filters.archived ? 1 : 0);

  if (scope !== null) {
    // A telecaller sees exactly their own leads. Applied before any client filter so
    // no combination of query parameters can widen it.
    conditions.push('l.assigned_to = ?');
    params.push(scope);
  } else if (filters.assignedTo === 'unassigned') {
    conditions.push('l.assigned_to IS NULL');
  } else if (typeof filters.assignedTo === 'number') {
    conditions.push('l.assigned_to = ?');
    params.push(filters.assignedTo);
  }

  if (filters.status) {
    conditions.push('l.status = ?');
    params.push(filters.status);
  }

  if (filters.source) {
    conditions.push('l.source = ?');
    params.push(filters.source);
  }

  if (filters.from) {
    conditions.push('l.created_at >= ?');
    params.push(`${filters.from} 00:00:00`);
  }

  if (filters.to) {
    conditions.push('l.created_at <= ?');
    params.push(`${filters.to} 23:59:59`);
  }

  if (filters.q) {
    /**
     * Searching a phone number has to ignore formatting: a telecaller types the digits
     * they see on a paper lead, and the stored value may carry spaces, brackets or a
     * country code. So the digits are matched against the column with its own
     * separators removed.
     */
    const term = likeTerm(filters.q);
    const digits = filters.q.replace(/\D/g, '');

    if (digits.length >= 4) {
      const digitTerm = `%${digits}%`;
      conditions.push(
        `(l.customer_name LIKE ? OR l.reference LIKE ? OR l.email LIKE ? OR l.city LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(l.phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(l.alternate_phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?)`,
      );
      params.push(term, term, term, term, digitTerm, digitTerm);
    } else {
      conditions.push(
        '(l.customer_name LIKE ? OR l.reference LIKE ? OR l.email LIKE ? OR l.city LIKE ?)',
      );
      params.push(term, term, term, term);
    }
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

export async function listLeads(
  filters: LeadListQuery,
  scope: OwnershipScope,
): Promise<Paginated<LeadRecord>> {
  const { where, params } = buildLeadFilters(filters, scope);

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM leads l ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  const rows = await query<LeadRow>(
    `${LEAD_SELECT} ${where} ORDER BY ${SORT_CLAUSES[filters.sort]} LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toLeadRecord), page, pageSize, total, totalPages };
}

/**
 * Finds leads whose stored number matches a dialled or incoming one.
 *
 * Compared on the trailing nine digits, because `+91 98765 43210` and `9876543210` are
 * the same customer and both forms will exist in a table populated from paper leads, a
 * website form and a spreadsheet import.
 *
 * Returns a list, not one lead: two leads can legitimately share a number — a household,
 * or the same person enquiring about two products — and silently picking one would
 * attach the call to the wrong record.
 */
export async function findLeadsByPhone(
  phone: string,
  scope: OwnershipScope,
): Promise<LeadRecord[]> {
  const key = phoneMatchKey(phone);
  if (key.length < 6) return [];

  const params: SqlParam[] = [`%${key}`, `%${key}`];
  let ownership = '';

  if (scope !== null) {
    ownership = ' AND l.assigned_to = ?';
    params.push(scope);
  }

  return (
    await query<LeadRow>(
      `${LEAD_SELECT}
        WHERE (
              REPLACE(REPLACE(REPLACE(REPLACE(l.phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
           OR REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(l.alternate_phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
        )
          AND l.is_archived = 0
          ${ownership}
        ORDER BY l.updated_at DESC
        LIMIT 10`,
      params,
    )
  ).map(toLeadRecord);
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export type InsertLeadData = {
  reference: string;
  customerName: string;
  phone: string;
  alternatePhone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  source: string;
  productInterest: string | null;
  status: LeadStatus;
  assignedTo: number | null;
  assignedBy: number | null;
  createdBy: number;
  enquiryId: number | null;
  attachmentKey: string | null;
  attachmentMime: string | null;
  summaryNote: string | null;
};

const INSERT_LEAD = `
  INSERT INTO leads
    (reference, customer_name, phone, alternate_phone, email, address, city, source,
     product_interest, status, assigned_to, assigned_at, assigned_by, created_by,
     enquiry_id, attachment_key, attachment_mime, summary_note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function insertLeadParams(data: InsertLeadData): SqlParam[] {
  return [
    data.reference,
    data.customerName,
    data.phone,
    data.alternatePhone,
    data.email,
    data.address,
    data.city,
    data.source,
    data.productInterest,
    data.status,
    data.assignedTo,
    // assigned_at is set only when there is an owner, so "unassigned since" and
    // "assigned at" cannot both be populated and disagree.
    data.assignedTo === null ? null : new Date(),
    data.assignedBy,
    data.createdBy,
    data.enquiryId,
    data.attachmentKey,
    data.attachmentMime,
    data.summaryNote,
  ];
}

/** Inserts inside the caller's transaction, so the creation activity cannot be lost. */
export async function insertLeadTx(
  connection: PoolConnection,
  data: InsertLeadData,
): Promise<number> {
  const [result] = await connection.execute(INSERT_LEAD, insertLeadParams(data));
  return (result as { insertId: number }).insertId;
}

export async function updateLeadFields(id: number, fields: UpdateLeadInput): Promise<boolean> {
  const assignments: string[] = [];
  const params: SqlParam[] = [];

  const push = (column: string, value: SqlParam) => {
    assignments.push(`${column} = ?`);
    params.push(value);
  };

  if (fields.customerName !== undefined) push('customer_name', fields.customerName);
  if (fields.phone !== undefined) push('phone', fields.phone);
  if (fields.alternatePhone !== undefined) push('alternate_phone', fields.alternatePhone);
  if (fields.email !== undefined) push('email', fields.email);
  if (fields.address !== undefined) push('address', fields.address);
  if (fields.city !== undefined) push('city', fields.city);
  if (fields.source !== undefined) push('source', fields.source);
  if (fields.productInterest !== undefined) push('product_interest', fields.productInterest);
  if (fields.summaryNote !== undefined) push('summary_note', fields.summaryNote);

  if (assignments.length === 0) return false;

  params.push(id);
  const result = await execute(`UPDATE leads SET ${assignments.join(', ')} WHERE id = ?`, params);
  return result.affectedRows > 0;
}

/**
 * Applies a status change inside a transaction.
 *
 * `converted_at` is set on the way in and cleared on the way out, so a lead moved to
 * `converted` by mistake and corrected does not keep a conversion date that would go on
 * inflating every report.
 */
export async function updateLeadStatusTx(
  connection: PoolConnection,
  id: number,
  status: LeadStatus,
): Promise<void> {
  await connection.execute(
    `UPDATE leads
        SET status = ?,
            converted_at = CASE
              WHEN ? = 'converted' AND converted_at IS NULL THEN NOW()
              WHEN ? <> 'converted' THEN NULL
              ELSE converted_at
            END
      WHERE id = ?`,
    [status, status, status, id],
  );
}

export async function assignLeadTx(
  connection: PoolConnection,
  id: number,
  assignedTo: number | null,
  assignedBy: number,
): Promise<void> {
  await connection.execute(
    `UPDATE leads
        SET assigned_to = ?,
            assigned_at = ?,
            assigned_by = ?
      WHERE id = ?`,
    [assignedTo, assignedTo === null ? null : new Date(), assignedBy, id],
  );
}

/**
 * Refreshes the two maintained cache columns from the tables that own the truth.
 *
 * Called in the same transaction as the change that invalidated them — a logged call,
 * a created or completed follow-up. Recomputing from the source rather than incrementing
 * means the value cannot drift: whatever happened concurrently, the answer after this
 * statement is the answer the source tables give.
 */
export async function refreshLeadCachesTx(
  connection: PoolConnection,
  leadId: number,
): Promise<void> {
  await connection.execute(
    `UPDATE leads l
        SET l.last_contacted_at = (
              SELECT MAX(c.started_at) FROM calls c
               WHERE c.lead_id = l.id AND c.outcome = 'answered'
            ),
            l.next_follow_up_at = (
              SELECT MIN(f.due_at) FROM follow_ups f
               WHERE f.lead_id = l.id AND f.state = 'pending'
            )
      WHERE l.id = ?`,
    [leadId],
  );
}

export async function archiveLead(id: number, archived: boolean): Promise<boolean> {
  const result = await execute('UPDATE leads SET is_archived = ? WHERE id = ?', [
    archived ? 1 : 0,
    id,
  ]);
  return result.affectedRows > 0;
}

/**
 * Permanent deletion.
 *
 * Cascades to notes, calls, follow-ups and activity. Reserved for genuine mistakes —
 * a duplicate import, a test row — which is why the ordinary admin action is archive,
 * and why this one is audited separately.
 */
export async function deleteLead(id: number): Promise<boolean> {
  const result = await execute('DELETE FROM leads WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

/**
 * The current attachment key, unscoped, for replacing one.
 *
 * Deliberately without an ownership filter: the caller has already checked ownership on
 * the lead itself, and this exists only so the superseded object can be deleted from
 * storage after the row has been repointed.
 */
export async function readLeadAttachmentKey(id: number): Promise<string | null> {
  const row = await queryOne<RowDataPacket & { attachment_key: string | null }>(
    'SELECT attachment_key FROM leads WHERE id = ? LIMIT 1',
    [id],
  );
  return row?.attachment_key ?? null;
}

export async function setLeadAttachment(
  id: number,
  key: string,
  mime: string,
): Promise<boolean> {
  const result = await execute(
    'UPDATE leads SET attachment_key = ?, attachment_mime = ? WHERE id = ?',
    [key, mime, id],
  );
  return result.affectedRows > 0;
}

/** Owner and reference only — for the permission checks that precede a write. */
export async function findLeadOwner(
  id: number,
): Promise<{ id: number; assignedTo: number | null; reference: string; status: LeadStatus } | null> {
  const row = await queryOne<
    RowDataPacket & {
      id: number;
      assigned_to: number | null;
      reference: string;
      status: LeadStatus;
    }
  >('SELECT id, assigned_to, reference, status FROM leads WHERE id = ? LIMIT 1', [id]);

  return row
    ? { id: row.id, assignedTo: row.assigned_to, reference: row.reference, status: row.status }
    : null;
}

/** Duplicate check before creating a lead. Matches on the trailing digits, as above. */
export async function findDuplicateByPhone(phone: string): Promise<LeadRecord | null> {
  const key = phoneMatchKey(phone);
  if (key.length < 6) return null;

  const row = await queryOne<LeadRow>(
    `${LEAD_SELECT}
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(l.phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?
        AND l.is_archived = 0
      ORDER BY l.created_at DESC
      LIMIT 1`,
    [`%${key}`],
  );

  return row ? toLeadRecord(row) : null;
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

export interface LeadNoteRow extends RowDataPacket {
  id: number;
  lead_id: number;
  user_id: number | null;
  user_name: string | null;
  kind: string;
  body: string;
  call_id: number | null;
  created_at: Date;
}

export type LeadNoteRecord = {
  id: number;
  leadId: number;
  userId: number | null;
  userName: string | null;
  kind: string;
  body: string;
  callId: number | null;
  createdAt: string;
};

function toNoteRecord(row: LeadNoteRow): LeadNoteRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    userId: row.user_id,
    userName: row.user_name,
    kind: row.kind,
    body: row.body,
    callId: row.call_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listLeadNotes(leadId: number, limit = 200): Promise<LeadNoteRecord[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await query<LeadNoteRow>(
    `SELECT n.id, n.lead_id, n.user_id, u.name AS user_name, n.kind, n.body, n.call_id, n.created_at
       FROM lead_notes n
       LEFT JOIN telecaller_users u ON u.id = n.user_id
      WHERE n.lead_id = ?
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${bounded}`,
    [leadId],
  );
  return rows.map(toNoteRecord);
}

export type InsertNoteData = {
  leadId: number;
  userId: number | null;
  kind: string;
  body: string;
  callId: number | null;
  clientUuid: string | null;
};

export async function insertNoteTx(
  connection: PoolConnection,
  data: InsertNoteData,
): Promise<number> {
  const [result] = await connection.execute(
    `INSERT INTO lead_notes (lead_id, user_id, kind, body, call_id, client_uuid)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.leadId, data.userId, data.kind, data.body, data.callId, data.clientUuid],
  );
  return (result as { insertId: number }).insertId;
}

/** Existing note for an offline-queue idempotency key, if the retry already landed. */
export async function findNoteByClientUuid(clientUuid: string): Promise<LeadNoteRecord | null> {
  const row = await queryOne<LeadNoteRow>(
    `SELECT n.id, n.lead_id, n.user_id, u.name AS user_name, n.kind, n.body, n.call_id, n.created_at
       FROM lead_notes n
       LEFT JOIN telecaller_users u ON u.id = n.user_id
      WHERE n.client_uuid = ?
      LIMIT 1`,
    [clientUuid],
  );
  return row ? toNoteRecord(row) : null;
}

/** Existing lead for an offline-queue idempotency key. */
export async function findLeadByClientUuid(clientUuid: string): Promise<LeadRecord | null> {
  const row = await queryOne<LeadRow>(
    `${LEAD_SELECT}
      WHERE l.id = (SELECT lead_id FROM lead_notes WHERE client_uuid = ? LIMIT 1)
      LIMIT 1`,
    [clientUuid],
  );
  return row ? toLeadRecord(row) : null;
}

/* -------------------------------------------------------------------------- */
/* Lead sources                                                                */
/* -------------------------------------------------------------------------- */

export interface LeadSourceRow extends RowDataPacket {
  id: number;
  slug: string;
  label: string;
  is_active: number;
  sort_order: number;
}

export type LeadSourceRecord = {
  id: number;
  slug: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
};

export async function listLeadSources(activeOnly = false): Promise<LeadSourceRecord[]> {
  const rows = await query<LeadSourceRow>(
    `SELECT id, slug, label, is_active, sort_order
       FROM lead_sources
       ${activeOnly ? 'WHERE is_active = 1' : ''}
      ORDER BY sort_order ASC, label ASC`,
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    label: row.label,
    isActive: row.is_active === 1,
    sortOrder: row.sort_order,
  }));
}

export async function leadSourceExists(slug: string): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM lead_sources WHERE slug = ? AND is_active = 1',
    [slug],
  );
  return Number(row?.total ?? 0) > 0;
}

export async function upsertLeadSource(data: {
  slug: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
}): Promise<void> {
  await execute(
    `INSERT INTO lead_sources (slug, label, is_active, sort_order)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE label = VALUES(label), is_active = VALUES(is_active), sort_order = VALUES(sort_order)`,
    [data.slug, data.label, data.isActive ? 1 : 0, data.sortOrder],
  );
}
