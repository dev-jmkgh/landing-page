import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../../db/pool';
import { resolvePage, type LeadStatus } from '../shared.schema';
import {
  LEAD_IMPORT_LIMITS,
  type LeadImportField,
  type LeadImportFileKind,
  type LeadImportListQuery,
  type LeadImportRowFilter,
  type LeadImportRowOutcome,
  type LeadImportRowState,
  type LeadImportState,
} from './leadImport.schema';

/**
 * SQL for `lead_imports` and `lead_import_rows` (migration 026). No rules here — the
 * service decides; this reads and writes.
 *
 * Times are compared with `UTC_TIMESTAMP()` rather than `NOW()`. The app's pool pins its
 * sessions to UTC so the two agree there, but the same statements are correct from any
 * connection this way, including an ad-hoc one in the server's own zone.
 *
 * Several statements bind a list of values with `IN (...)`. Each distinct number of
 * placeholders is a distinct prepared statement, cached per pooled connection, so lists
 * are padded to a few fixed lengths (see `paddedPlaceholders`) instead of producing a new
 * statement text for every list size an import happens to have.
 */

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

export type LeadImportColumn = {
  /** Zero-based; the key the preview's `columnMap` uses. */
  index: number;
  /** The column letter Excel shows. */
  letter: string;
  header: string;
  field: LeadImportField | null;
  matchedBy: 'alias' | 'manual' | null;
  /** True for the columns the import cannot do without: the name and the phone. */
  required: boolean;
};

/**
 * What the check learned about the file, kept with the import so a reload, a resumed
 * import or a page of rows shows the same picture as the first preview.
 *
 * Stored in the `column_map` JSON column. Migration 026 describes that column as the
 * column list alone; the sheet names, the notices and the split of the duplicate total
 * are facts about the file at preview time too, the table has nowhere else to hold them,
 * and adding columns would mean a second migration for values nothing ever filters on.
 * A bare array — the column list alone — is still read correctly.
 */
export type ImportFacts = {
  columns: LeadImportColumn[];
  sheetNames: string[];
  notices: string[];
  duplicatesInFile: number;
  duplicatesExisting: number;
};

export type LeadImportEntity = {
  id: number;
  createdBy: number | null;
  createdByName: string | null;
  fileName: string;
  fileKind: LeadImportFileKind;
  fileSha256: string;
  fileSize: number;
  sheetName: string | null;
  headerRow: number;
  facts: ImportFacts;
  defaultAssignee: number | null;
  defaultAssigneeName: string | null;
  defaultSource: string;
  defaultStatus: LeadStatus;
  state: LeadImportState;
  totals: { rows: number; ready: number; warnings: number; errors: number; duplicates: number };
  /** The final counts, written once at completion or cancellation; null until then. */
  snapshot: { created: number; skipped: number; failed: number } | null;
  lockUntil: string | null;
  expiresAt: string;
  committedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type RowMessages = { errors: Record<string, string>; warnings: Record<string, string> };

export type StagedRow = {
  id: number;
  sheetRow: number;
  outcome: LeadImportRowOutcome;
  state: LeadImportRowState;
  phoneKey: string | null;
  payload: Record<string, unknown> | null;
  raw: (string | null)[] | null;
  messages: RowMessages;
  duplicateOfRow: number | null;
  duplicateLead: {
    id: number;
    reference: string;
    customerName: string;
    assignedToName: string | null;
  } | null;
  clientUuid: string;
  leadId: number | null;
  leadReference: string | null;
  resultMessage: string | null;
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

/**
 * A JSON column's value. MySQL hands it over parsed; MariaDB, where JSON is an alias for
 * LONGTEXT, hands over the text.
 */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function asStringMap(value: unknown): Record<string, string> {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function parseFacts(value: unknown): ImportFacts {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    return {
      columns: parsed as LeadImportColumn[],
      sheetNames: [],
      notices: [],
      duplicatesInFile: 0,
      duplicatesExisting: 0,
    };
  }
  const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<ImportFacts>;
  return {
    columns: Array.isArray(record.columns) ? record.columns : [],
    sheetNames: Array.isArray(record.sheetNames) ? record.sheetNames.map(String) : [],
    notices: Array.isArray(record.notices) ? record.notices.map(String) : [],
    duplicatesInFile: Number(record.duplicatesInFile ?? 0),
    duplicatesExisting: Number(record.duplicatesExisting ?? 0),
  };
}

/**
 * `(?, ?, …)` padded up to the next of a few fixed lengths, with the parameters padded to
 * match using a value that can never be found. Keeps the number of distinct statement
 * texts — each one a cached prepared statement on every pooled connection — to a handful.
 */
function paddedPlaceholders<T extends SqlParam>(
  values: T[],
  filler: T,
  sizes: readonly number[],
): { sql: string; params: SqlParam[] } {
  const size = sizes.find((candidate) => candidate >= values.length) ?? values.length;
  const params: SqlParam[] = [...values];
  while (params.length < size) params.push(filler);
  return { sql: params.map(() => '?').join(', '), params };
}

const PAD_SIZES = [10, 100, 500] as const;

/* -------------------------------------------------------------------------- */
/* Imports                                                                     */
/* -------------------------------------------------------------------------- */

interface ImportDbRow extends RowDataPacket {
  id: number;
  created_by: number | null;
  created_by_name: string | null;
  file_name: string;
  file_kind: LeadImportFileKind;
  file_sha256: string;
  file_size: number;
  sheet_name: string | null;
  header_row: number;
  column_map: unknown;
  default_assignee: number | null;
  default_assignee_name: string | null;
  default_source: string;
  default_status: string;
  state: LeadImportState;
  total_rows: number;
  ready_rows: number;
  warning_rows: number;
  error_rows: number;
  duplicate_rows: number;
  created_count: number | null;
  skipped_count: number | null;
  failed_count: number | null;
  lock_until: Date | null;
  expires_at: Date;
  committed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

function toEntity(row: ImportDbRow): LeadImportEntity {
  return {
    id: Number(row.id),
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdByName: row.created_by_name,
    fileName: row.file_name,
    fileKind: row.file_kind,
    fileSha256: row.file_sha256,
    fileSize: Number(row.file_size),
    sheetName: row.sheet_name,
    headerRow: Number(row.header_row),
    facts: parseFacts(row.column_map),
    defaultAssignee: row.default_assignee === null ? null : Number(row.default_assignee),
    defaultAssigneeName: row.default_assignee_name,
    defaultSource: row.default_source,
    defaultStatus: row.default_status as LeadStatus,
    state: row.state,
    totals: {
      rows: Number(row.total_rows),
      ready: Number(row.ready_rows),
      warnings: Number(row.warning_rows),
      errors: Number(row.error_rows),
      duplicates: Number(row.duplicate_rows),
    },
    snapshot:
      row.created_count === null
        ? null
        : {
            created: Number(row.created_count),
            skipped: Number(row.skipped_count ?? 0),
            failed: Number(row.failed_count ?? 0),
          },
    lockUntil: iso(row.lock_until),
    expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
    committedAt: iso(row.committed_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

const IMPORT_SELECT = `
  SELECT i.id, i.created_by, cu.name AS created_by_name, i.file_name, i.file_kind,
         i.file_sha256, i.file_size, i.sheet_name, i.header_row, i.column_map,
         i.default_assignee, au.name AS default_assignee_name, i.default_source,
         i.default_status, i.state, i.total_rows, i.ready_rows, i.warning_rows,
         i.error_rows, i.duplicate_rows, i.created_count, i.skipped_count, i.failed_count,
         i.lock_until, i.expires_at, i.committed_at, i.completed_at, i.created_at
    FROM lead_imports i
    LEFT JOIN telecaller_users cu ON cu.id = i.created_by
    LEFT JOIN telecaller_users au ON au.id = i.default_assignee
`;

export type InsertLeadImportData = {
  createdBy: number;
  fileName: string;
  fileKind: LeadImportFileKind;
  fileSha256: string;
  fileSize: number;
  sheetName: string | null;
  headerRow: number;
  facts: ImportFacts;
  defaultAssignee: number | null;
  defaultSource: string;
  defaultStatus: LeadStatus;
  totals: { rows: number; ready: number; warnings: number; errors: number; duplicates: number };
};

export async function insertLeadImportTx(
  connection: PoolConnection,
  data: InsertLeadImportData,
): Promise<number> {
  const [result] = await connection.execute(
    `INSERT INTO lead_imports
       (created_by, file_name, file_kind, file_sha256, file_size, sheet_name, header_row,
        column_map, default_assignee, default_source, default_status, state,
        total_rows, ready_rows, warning_rows, error_rows, duplicate_rows, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?,
             UTC_TIMESTAMP() + INTERVAL ? HOUR)`,
    [
      data.createdBy,
      data.fileName,
      data.fileKind,
      data.fileSha256,
      data.fileSize,
      data.sheetName,
      data.headerRow,
      JSON.stringify(data.facts),
      data.defaultAssignee,
      data.defaultSource,
      data.defaultStatus,
      data.totals.rows,
      data.totals.ready,
      data.totals.warnings,
      data.totals.errors,
      data.totals.duplicates,
      LEAD_IMPORT_LIMITS.draftTtlHours,
    ],
  );
  return (result as { insertId: number }).insertId;
}

export type InsertStagedRow = {
  sheetRow: number;
  outcome: LeadImportRowOutcome;
  state: LeadImportRowState;
  phoneKey: string | null;
  payload: Record<string, unknown>;
  raw: (string | null)[];
  messages: RowMessages;
  duplicateOfRow: number | null;
  duplicateLeadId: number | null;
  clientUuid: string;
};

const ROW_INSERT_COLUMNS = `
  INSERT INTO lead_import_rows
    (import_id, sheet_row, outcome, state, phone_key, payload, raw, messages,
     duplicate_of_row, duplicate_lead_id, client_uuid)
  VALUES `;

/**
 * Multi-row inserts, so a 2,000-row file is a handful of statements rather than 2,000.
 * Chunk sizes are fixed (200, then 50, 10, 1) so at most four statement texts exist.
 */
export async function insertStagedRowsTx(
  connection: PoolConnection,
  importId: number,
  rows: InsertStagedRow[],
): Promise<void> {
  let offset = 0;
  for (const size of [200, 50, 10, 1]) {
    while (rows.length - offset >= size) {
      const chunk = rows.slice(offset, offset + size);
      const params: SqlParam[] = [];
      for (const row of chunk) {
        params.push(
          importId,
          row.sheetRow,
          row.outcome,
          row.state,
          row.phoneKey,
          JSON.stringify(row.payload),
          JSON.stringify(row.raw),
          JSON.stringify(row.messages),
          row.duplicateOfRow,
          row.duplicateLeadId,
          row.clientUuid,
        );
      }
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      await connection.execute(`${ROW_INSERT_COLUMNS}${placeholders}`, params);
      offset += size;
    }
  }
}

export async function findLeadImport(id: number): Promise<LeadImportEntity | null> {
  const row = await queryOne<ImportDbRow>(`${IMPORT_SELECT} WHERE i.id = ? LIMIT 1`, [id]);
  return row ? toEntity(row) : null;
}

export async function listLeadImportsPage(
  filters: LeadImportListQuery,
  actorId: number,
): Promise<{ items: LeadImportEntity[]; page: number; pageSize: number; total: number; totalPages: number }> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.state) {
    conditions.push('i.state = ?');
    params.push(filters.state);
  }
  if (filters.mine) {
    conditions.push('i.created_by = ?');
    params.push(actorId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM lead_imports i ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(filters, total);

  const rows = await query<ImportDbRow>(
    `${IMPORT_SELECT} ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toEntity), page, pageSize, total, totalPages };
}

/** Live row counts per state, for several imports at once. */
export async function countRowsByState(
  importIds: number[],
): Promise<Map<number, Partial<Record<LeadImportRowState, number>>>> {
  const result = new Map<number, Partial<Record<LeadImportRowState, number>>>();
  const unique = [...new Set(importIds)];
  if (unique.length === 0) return result;

  const { sql, params } = paddedPlaceholders(unique, 0, PAD_SIZES);
  const rows = await query<
    RowDataPacket & { import_id: number; state: LeadImportRowState; total: number }
  >(
    `SELECT import_id, state, COUNT(*) AS total
       FROM lead_import_rows
      WHERE import_id IN (${sql})
      GROUP BY import_id, state`,
    params,
  );

  for (const row of rows) {
    const id = Number(row.import_id);
    const counts = result.get(id) ?? {};
    counts[row.state] = Number(row.total);
    result.set(id, counts);
  }
  return result;
}

/** The same file seen before, for the "already imported" notice. */
export async function findImportByHash(
  sha256: string,
  excludeId: number,
): Promise<{
  id: number;
  state: LeadImportState;
  createdAt: string;
  createdByName: string | null;
  createdCount: number | null;
} | null> {
  const row = await queryOne<
    RowDataPacket & {
      id: number;
      state: LeadImportState;
      created_at: Date;
      created_by_name: string | null;
      created_count: number | null;
    }
  >(
    `SELECT i.id, i.state, i.created_at, u.name AS created_by_name, i.created_count
       FROM lead_imports i
       LEFT JOIN telecaller_users u ON u.id = i.created_by
      WHERE i.file_sha256 = ?
        AND i.id <> ?
        AND (i.state IN ('committing', 'completed') OR (i.state = 'cancelled' AND i.created_count > 0))
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 1`,
    [sha256, excludeId],
  );
  return row
    ? {
        id: Number(row.id),
        state: row.state,
        createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
        createdByName: row.created_by_name,
        createdCount: row.created_count === null ? null : Number(row.created_count),
      }
    : null;
}

/**
 * Discards the caller's own unconfirmed draft that a new check replaces. Only a `ready`
 * draft, only the creator's: nothing was imported from it, so no audit row either.
 */
export async function discardReadyDraftTx(
  connection: PoolConnection,
  importId: number,
  createdBy: number,
): Promise<boolean> {
  const [result] = await connection.execute(
    `UPDATE lead_imports
        SET state = 'cancelled', lock_until = NULL, completed_at = UTC_TIMESTAMP(),
            created_count = 0, skipped_count = 0, failed_count = 0
      WHERE id = ? AND created_by = ? AND state = 'ready'`,
    [importId, createdBy],
  );
  const changed = (result as { affectedRows: number }).affectedRows > 0;
  if (changed) {
    await connection.execute('DELETE FROM lead_import_rows WHERE import_id = ?', [importId]);
  }
  return changed;
}

/* -------------------------------------------------------------------------- */
/* The commit lock                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Takes the import's commit lock. Exactly one caller gets `true`.
 *
 * The lock is a time, not a flag: a batch that dies with the process leaves `lock_until`
 * in the past and the next caller simply takes over — so there is nothing to clean up
 * after a crash, and no import can be stuck forever.
 */
export async function claimCommitLock(importId: number): Promise<boolean> {
  const result = await execute(
    `UPDATE lead_imports
        SET state = 'committing',
            lock_until = UTC_TIMESTAMP() + INTERVAL ? SECOND,
            committed_at = COALESCE(committed_at, UTC_TIMESTAMP())
      WHERE id = ?
        AND ((state = 'ready' AND expires_at >= UTC_TIMESTAMP())
          OR (state = 'committing' AND (lock_until IS NULL OR lock_until < UTC_TIMESTAMP())))`,
    [LEAD_IMPORT_LIMITS.lockSeconds, importId],
  );
  return result.affectedRows === 1;
}

export async function extendCommitLock(importId: number): Promise<void> {
  await execute(
    `UPDATE lead_imports
        SET lock_until = UTC_TIMESTAMP() + INTERVAL ? SECOND
      WHERE id = ? AND state = 'committing'`,
    [LEAD_IMPORT_LIMITS.lockSeconds, importId],
  );
}

export async function releaseCommitLock(importId: number): Promise<void> {
  await execute(
    `UPDATE lead_imports SET lock_until = NULL WHERE id = ? AND state = 'committing'`,
    [importId],
  );
}

/**
 * Moves an import to `cancelled` — from `ready`, or from `committing` when no batch holds
 * the lock. Exactly one caller gets `true`; a batch in flight makes this `false`, so a
 * cancel can never delete rows a running batch is about to record.
 */
export async function claimCancel(importId: number): Promise<boolean> {
  const result = await execute(
    `UPDATE lead_imports
        SET state = 'cancelled', lock_until = NULL
      WHERE id = ?
        AND (state = 'ready'
          OR (state = 'committing' AND (lock_until IS NULL OR lock_until < UTC_TIMESTAMP())))`,
    [importId],
  );
  return result.affectedRows === 1;
}

/** Marks a `ready` draft whose time ran out as expired (and clears its rows). */
export async function expireDraft(importId: number): Promise<void> {
  const result = await execute(
    `UPDATE lead_imports SET state = 'expired', lock_until = NULL
      WHERE id = ? AND state = 'ready' AND expires_at < UTC_TIMESTAMP()`,
    [importId],
  );
  if (result.affectedRows > 0) {
    await execute('DELETE FROM lead_import_rows WHERE import_id = ?', [importId]);
  }
}

/* -------------------------------------------------------------------------- */
/* Committing rows                                                             */
/* -------------------------------------------------------------------------- */

export type PendingRow = {
  id: number;
  sheetRow: number;
  payload: Record<string, unknown> | null;
  clientUuid: string;
};

/** The next rows to create, in sheet order. `limit` is bounded by the caller's schema. */
export async function nextPendingRows(importId: number, limit: number): Promise<PendingRow[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), LEAD_IMPORT_LIMITS.batchMax);
  const rows = await query<
    RowDataPacket & { id: number; sheet_row: number; payload: unknown; client_uuid: string }
  >(
    `SELECT id, sheet_row, payload, client_uuid
       FROM lead_import_rows
      WHERE import_id = ? AND state = 'pending'
      ORDER BY sheet_row ASC
      LIMIT ${bounded}`,
    [importId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    sheetRow: Number(row.sheet_row),
    payload: asRecord(row.payload),
    clientUuid: row.client_uuid,
  }));
}

/**
 * Records what happened to one row. `state = 'pending'` in the WHERE makes the first
 * writer win, so a row can never be recorded twice even if two attempts overlapped.
 */
export async function recordRowResult(
  rowId: number,
  result: { state: 'created' | 'skipped' | 'failed'; leadId: number | null; message: string | null },
): Promise<boolean> {
  const outcome = await execute(
    `UPDATE lead_import_rows
        SET state = ?, lead_id = ?, result_message = ?, processed_at = UTC_TIMESTAMP()
      WHERE id = ? AND state = 'pending'`,
    [result.state, result.leadId, result.message ? result.message.slice(0, 255) : null, rowId],
  );
  return outcome.affectedRows > 0;
}

/** Writes the final counts and closes a committing import as completed. */
export async function completeImport(
  importId: number,
  counts: { created: number; skipped: number; failed: number },
): Promise<boolean> {
  const result = await execute(
    `UPDATE lead_imports
        SET state = 'completed', created_count = ?, skipped_count = ?, failed_count = ?,
            completed_at = UTC_TIMESTAMP(), lock_until = NULL
      WHERE id = ? AND state = 'committing'`,
    [counts.created, counts.skipped, counts.failed, importId],
  );
  return result.affectedRows === 1;
}

/** The final counts of an import that was just cancelled, and its unimported rows gone. */
export async function finishCancelledImport(
  importId: number,
  counts: { created: number; skipped: number; failed: number },
): Promise<void> {
  await execute(
    `UPDATE lead_imports
        SET created_count = ?, skipped_count = ?, failed_count = ?, completed_at = UTC_TIMESTAMP()
      WHERE id = ? AND state = 'cancelled'`,
    [counts.created, counts.skipped, counts.failed, importId],
  );
  // The staged personal data of rows that were never imported has no further use.
  await execute(
    `DELETE FROM lead_import_rows WHERE import_id = ? AND state IN ('pending', 'not_imported')`,
    [importId],
  );
}

/**
 * Who received leads from this import, and how many: one summary notification each. A
 * lead its own creator kept is not news to anyone.
 */
export async function importedLeadsByAssignee(
  importId: number,
): Promise<{ userId: number; total: number; firstLeadId: number }[]> {
  const rows = await query<
    RowDataPacket & { user_id: number; total: number; first_lead_id: number }
  >(
    `SELECT l.assigned_to AS user_id, COUNT(*) AS total, MIN(l.id) AS first_lead_id
       FROM lead_import_rows r
       JOIN leads l ON l.id = r.lead_id
      WHERE r.import_id = ?
        AND r.state = 'created'
        AND l.assigned_to IS NOT NULL
        AND l.assigned_to <> IFNULL(l.created_by, 0)
      GROUP BY l.assigned_to`,
    [importId],
  );
  return rows.map((row) => ({
    userId: Number(row.user_id),
    total: Number(row.total),
    firstLeadId: Number(row.first_lead_id),
  }));
}

/* -------------------------------------------------------------------------- */
/* Reading rows                                                                */
/* -------------------------------------------------------------------------- */

interface StagedDbRow extends RowDataPacket {
  id: number;
  sheet_row: number;
  outcome: LeadImportRowOutcome;
  state: LeadImportRowState;
  phone_key: string | null;
  payload: unknown;
  raw: unknown;
  messages: unknown;
  duplicate_of_row: number | null;
  duplicate_lead_id: number | null;
  client_uuid: string;
  lead_id: number | null;
  result_message: string | null;
  lead_reference: string | null;
  duplicate_reference: string | null;
  duplicate_customer_name: string | null;
  duplicate_assigned_to_name: string | null;
}

const ROW_SELECT = `
  SELECT r.id, r.sheet_row, r.outcome, r.state, r.phone_key, r.payload, r.raw, r.messages,
         r.duplicate_of_row, r.duplicate_lead_id, r.client_uuid, r.lead_id, r.result_message,
         l.reference AS lead_reference,
         d.reference AS duplicate_reference, d.customer_name AS duplicate_customer_name,
         du.name AS duplicate_assigned_to_name
    FROM lead_import_rows r
    LEFT JOIN leads l ON l.id = r.lead_id
    LEFT JOIN leads d ON d.id = r.duplicate_lead_id
    LEFT JOIN telecaller_users du ON du.id = d.assigned_to
`;

function toStagedRow(row: StagedDbRow): StagedRow {
  const messages = asRecord(row.messages) ?? {};
  const raw = parseJson(row.raw);
  return {
    id: Number(row.id),
    sheetRow: Number(row.sheet_row),
    outcome: row.outcome,
    state: row.state,
    phoneKey: row.phone_key,
    payload: asRecord(row.payload),
    raw: Array.isArray(raw) ? raw.map((cell) => (cell === null || cell === undefined ? null : String(cell))) : null,
    messages: { errors: asStringMap(messages.errors), warnings: asStringMap(messages.warnings) },
    duplicateOfRow: row.duplicate_of_row === null ? null : Number(row.duplicate_of_row),
    duplicateLead:
      row.duplicate_lead_id !== null && row.duplicate_reference !== null
        ? {
            id: Number(row.duplicate_lead_id),
            reference: row.duplicate_reference,
            customerName: row.duplicate_customer_name ?? '',
            assignedToName: row.duplicate_assigned_to_name,
          }
        : null,
    clientUuid: row.client_uuid,
    leadId: row.lead_id === null ? null : Number(row.lead_id),
    leadReference: row.lead_reference,
    resultMessage: row.result_message,
  };
}

function rowFilterSql(filter: LeadImportRowFilter, params: SqlParam[]): string {
  let sql = '';
  // Closed enums, already validated; bound all the same.
  if (filter.outcome && filter.outcome.length > 0) {
    sql += ` AND r.outcome IN (${filter.outcome.map(() => '?').join(', ')})`;
    params.push(...filter.outcome);
  }
  if (filter.state && filter.state.length > 0) {
    sql += ` AND r.state IN (${filter.state.map(() => '?').join(', ')})`;
    params.push(...filter.state);
  }
  return sql;
}

/** One page of an import's rows, in sheet order. */
export async function listStagedRowsPage(
  importId: number,
  filter: LeadImportRowFilter,
  pagination: { page: number; pageSize: number },
): Promise<{ items: StagedRow[]; page: number; pageSize: number; total: number; totalPages: number }> {
  const params: SqlParam[] = [importId];
  const where = `WHERE r.import_id = ?${rowFilterSql(filter, params)}`;

  const countRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM lead_import_rows r ${where}`,
    params,
  );
  const total = Number(countRow?.total ?? 0);
  const { page, pageSize, offset, totalPages } = resolvePage(pagination, total);

  const rows = await query<StagedDbRow>(
    `${ROW_SELECT} ${where} ORDER BY r.sheet_row ASC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(toStagedRow), page, pageSize, total, totalPages };
}

/** Every matching row (at most the row limit), for the rows-to-fix download. */
export async function listStagedRowsForExport(
  importId: number,
  filter: LeadImportRowFilter,
): Promise<StagedRow[]> {
  const params: SqlParam[] = [importId];
  const where = `WHERE r.import_id = ?${rowFilterSql(filter, params)}`;
  const rows = await query<StagedDbRow>(
    `${ROW_SELECT} ${where} ORDER BY r.sheet_row ASC LIMIT ${LEAD_IMPORT_LIMITS.maxRows}`,
    params,
  );
  return rows.map(toStagedRow);
}

/** The rows a commit batch just handled, in sheet order. */
export async function findStagedRowsByIds(ids: number[]): Promise<StagedRow[]> {
  if (ids.length === 0) return [];
  const result: StagedRow[] = [];
  // A batch is at most 250 rows; read them in padded slices of 100.
  for (let start = 0; start < ids.length; start += 100) {
    const { sql, params } = paddedPlaceholders(ids.slice(start, start + 100), 0, PAD_SIZES);
    const rows = await query<StagedDbRow>(`${ROW_SELECT} WHERE r.id IN (${sql})`, params);
    result.push(...rows.map(toStagedRow));
  }
  return result.sort((a, b) => a.sheetRow - b.sheetRow);
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

export type ExistingLeadForPhone = {
  id: number;
  reference: string;
  customerName: string;
  assignedToName: string | null;
};

/**
 * The bulk form of `findDuplicateByPhone`: the active lead already holding each number.
 *
 * Same rule, same index: `leads.phone_key` (migration 015) is the trailing nine digits of
 * an ACTIVE lead's number and NULL once archived, so archived leads do not count. The
 * oldest lead wins when a number is somehow held twice, exactly as in the single check.
 * About four indexed queries for a 2,000-row file instead of 2,000.
 *
 * `keys` are `phoneMatchKey` values, the same expression as the generated column. Keys
 * shorter than six digits are skipped, as `findDuplicateByPhone` skips them.
 */
export async function findActiveLeadsByPhoneKeys(
  keys: string[],
): Promise<Map<string, ExistingLeadForPhone>> {
  const result = new Map<string, ExistingLeadForPhone>();
  const unique = [...new Set(keys.filter((key) => key.length >= 6))];

  for (let start = 0; start < unique.length; start += 500) {
    // Padded with a key no lead can have — phone_key holds digits only.
    const { sql, params } = paddedPlaceholders(unique.slice(start, start + 500), 'x', [500]);
    const rows = await query<
      RowDataPacket & {
        id: number;
        reference: string;
        customer_name: string;
        phone_key: string;
        assigned_to_name: string | null;
      }
    >(
      `SELECT l.id, l.reference, l.customer_name, l.phone_key, u.name AS assigned_to_name
         FROM leads l
         LEFT JOIN telecaller_users u ON u.id = l.assigned_to
        WHERE l.phone_key IN (${sql})
        ORDER BY l.created_at ASC, l.id ASC`,
      params,
    );
    for (const row of rows) {
      if (result.has(row.phone_key)) continue;
      result.set(row.phone_key, {
        id: Number(row.id),
        reference: row.reference,
        customerName: row.customer_name,
        assignedToName: row.assigned_to_name,
      });
    }
  }

  return result;
}

/** Names for a page's worth of employee ids. */
export async function employeeNames(ids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
  for (let start = 0; start < unique.length; start += 100) {
    const { sql, params } = paddedPlaceholders(unique.slice(start, start + 100), 0, PAD_SIZES);
    const rows = await query<RowDataPacket & { id: number; name: string }>(
      `SELECT id, name FROM telecaller_users WHERE id IN (${sql})`,
      params,
    );
    for (const row of rows) result.set(Number(row.id), row.name);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The opportunistic sweep: there is no cron, so the preview and the import list run this
 * first. Expires unconfirmed drafts past their lifetime, clears the staged rows nobody
 * needs any more — immediately for expired drafts and cancelled imports' unimported
 * rows, after the retention period for everything else — and returns the commits that
 * have been abandoned, for the service to finish off.
 */
export async function sweepLeadImports(): Promise<number[]> {
  await execute(
    `UPDATE lead_imports SET state = 'expired', lock_until = NULL
      WHERE state = 'ready' AND expires_at < UTC_TIMESTAMP()`,
  );
  await execute(
    `DELETE r FROM lead_import_rows r
       JOIN lead_imports i ON i.id = r.import_id
      WHERE i.state = 'expired'`,
  );
  await execute(
    `DELETE r FROM lead_import_rows r
       JOIN lead_imports i ON i.id = r.import_id
      WHERE i.state = 'cancelled' AND r.state IN ('pending', 'not_imported')`,
  );
  await execute(
    `DELETE r FROM lead_import_rows r
       JOIN lead_imports i ON i.id = r.import_id
      WHERE i.state IN ('completed', 'cancelled')
        AND i.completed_at < UTC_TIMESTAMP() - INTERVAL ? DAY`,
    [LEAD_IMPORT_LIMITS.retentionDays],
  );

  const abandoned = await query<RowDataPacket & { id: number }>(
    `SELECT id FROM lead_imports
      WHERE state = 'committing'
        AND updated_at < UTC_TIMESTAMP() - INTERVAL ? HOUR
        AND (lock_until IS NULL OR lock_until < UTC_TIMESTAMP())
      ORDER BY id
      LIMIT 20`,
    [LEAD_IMPORT_LIMITS.abandonedHours],
  );
  return abandoned.map((row) => Number(row.id));
}
