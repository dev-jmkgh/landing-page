import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ZodError } from 'zod';
import { withTransaction } from '../../../db/pool';
import { toFieldErrors } from '../../../middleware/validate';
import {
  HttpError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from '../../../utils/httpError';
import { logger } from '../../../utils/logger';
import { safeFilename } from '../../../utils/text';
import { hasRole, type Actor } from '../actor';
import { recordAudit } from '../activity/activity.repository';
import { formatCompanyDateTime } from '../companyTime';
import {
  findEmployee,
  listAssignableEmployees,
  type EmployeeRecord,
} from '../employees/employee.repository';
import {
  findLeadByClientUuid,
  listLeadSources,
  type LeadSourceRecord,
} from '../leads/lead.repository';
import { createLeadSchema } from '../leads/lead.schema';
import { createLead } from '../leads/lead.service';
import { queueNotifications } from '../notifications/notification.repository';
import { LEAD_STATUSES, phoneMatchKey, type LeadStatus } from '../shared.schema';
import {
  BLANK_CELL,
  ImportFileError,
  cellToFieldText,
  columnLetter,
  decodeCsvText,
  detectFileKind,
  formatCount,
  inspectZipContainer,
  looksLikeFormula,
  readCsv,
  runParseWorker,
  type Cell,
  type FieldText,
  type ParsedSheet,
  type SheetRow,
} from './leadImport.parser';
import {
  claimCancel,
  claimCommitLock,
  completeImport,
  countRowsByState,
  discardReadyDraftTx,
  employeeNames,
  expireDraft,
  extendCommitLock,
  findActiveLeadsByPhoneKeys,
  findImportByHash,
  findLeadImport,
  findStagedRowsByIds,
  finishCancelledImport,
  importedLeadsByAssignee,
  insertLeadImportTx,
  insertStagedRowsTx,
  listLeadImportsPage,
  listStagedRowsForExport,
  listStagedRowsPage,
  nextPendingRows,
  recordRowResult,
  releaseCommitLock,
  sweepLeadImports,
  type ImportFacts,
  type InsertStagedRow,
  type LeadImportColumn,
  type LeadImportEntity,
  type PendingRow,
  type StagedRow,
} from './leadImport.repository';
import {
  ALIAS_TO_FIELD,
  LEAD_IMPORT_FIELD_LABELS,
  LEAD_IMPORT_LIMITS,
  LEAD_STATUS_LABELS,
  STATUS_ALIASES,
  UNASSIGNED_TOKENS,
  ZERO_WIDTH,
  normaliseHeader,
  type LeadImportCommitInput,
  type LeadImportDetailQuery,
  type LeadImportField,
  type LeadImportFileKind,
  type LeadImportListQuery,
  type LeadImportPreviewInput,
  type LeadImportRowFilter,
  type LeadImportRowOutcome,
  type LeadImportRowState,
  type LeadImportRowsCsvQuery,
  type LeadImportState,
} from './leadImport.schema';

/**
 * Lead import: check a spreadsheet, then create its good rows in batches.
 *
 * WHY ROW BY ROW THROUGH createLead, AND NOT ONE BIG TRANSACTION
 *
 * `createLead` is the only lead write path and it owns its own transaction; its checks
 * (the owner is active, the source exists, nobody already holds the number) run on other
 * pool connections first. Wrapping two thousand calls in an outer transaction would break
 * the duplicate check — it cannot see the batch's own uncommitted rows — and would hold
 * locks on `leads` across two thousand inserts, four times the 500-row budget bulk
 * assignment already treats as the edge. So each row is a complete unit (the lead, its
 * activity and its note commit together), and the preview is the all-or-nothing gate:
 * the person sees exactly what will be skipped before anything is written.
 *
 * Retries cannot duplicate. Every staged row carries a client UUID minted at preview and
 * passed to `createLead`, whose replay returns the lead an earlier attempt created; the
 * per-import lock stops two windows committing at once; and a row's result is recorded
 * only while it is still `pending`, so the first writer wins.
 *
 * WHAT A TELECALLER SEES
 *
 * One notification per assignee per import ("12 new leads assigned") instead of one per
 * lead, and an ordinary "lead created" timeline row reading "added this lead from a
 * spreadsheet". No file names, import ids or internal words reach the phone.
 */

/* -------------------------------------------------------------------------- */
/* API shapes                                                                  */
/* -------------------------------------------------------------------------- */

export type LeadImportProgress = {
  pending: number;
  created: number;
  skipped: number;
  failed: number;
  notImported: number;
};

export type LeadImportSummary = {
  id: number;
  fileName: string;
  fileKind: LeadImportFileKind;
  fileSize: number;
  sheetName: string | null;
  sheetNames: string[];
  headerRow: number;
  state: LeadImportState;
  defaults: {
    assignedTo: number | null;
    assignedToName: string | null;
    source: string;
    status: LeadStatus;
  };
  /** Facts about the file when it was checked. They never change. */
  totals: {
    rows: number;
    ready: number;
    warnings: number;
    errors: number;
    duplicatesInFile: number;
    duplicatesExisting: number;
  };
  /** Live, counted from the rows (or the final counts once the import has ended). */
  progress: LeadImportProgress;
  createdBy: { id: number | null; name: string | null };
  createdAt: string;
  expiresAt: string;
  committedAt: string | null;
  completedAt: string | null;
};

export type LeadImportRowValues = {
  customerName: string | null;
  phone: string | null;
  alternatePhone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  source: string | null;
  productInterest: string | null;
  status: string | null;
  summaryNote: string | null;
  assignedTo: number | null;
  assignedToName: string | null;
};

export type LeadImportDuplicateOf =
  | { kind: 'row'; sheetRow: number }
  | { kind: 'lead'; id: number; reference: string; customerName: string; assignedToName: string | null };

export type LeadImportRowView = {
  sheetRow: number;
  outcome: LeadImportRowOutcome;
  state: LeadImportRowState;
  values: LeadImportRowValues;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  duplicateOf: LeadImportDuplicateOf | null;
  leadId: number | null;
  leadReference: string | null;
  resultMessage: string | null;
  /** The original cells, aligned with the columns — only for rows that were not imported. */
  raw: (string | null)[] | null;
};

export type RowsPage = { page: number; pageSize: number; total: number; totalPages: number };

export type LeadImportPreviewResult = {
  import: LeadImportSummary;
  columns: LeadImportColumn[];
  /** The first page of rows, in sheet order. */
  rows: LeadImportRowView[];
  rowsPage: RowsPage;
  notices: string[];
};

export type LeadImportDetailResult = LeadImportPreviewResult & {
  /** True once the staged rows were cleared (expired, or past the retention period). */
  rowsPurged: boolean;
};

export type LeadImportCommitResult = {
  import: LeadImportSummary;
  processed: number;
  remaining: number;
  done: boolean;
  /** Only the rows this call handled. */
  rows: LeadImportRowView[];
};

/* -------------------------------------------------------------------------- */
/* Summaries and rows                                                          */
/* -------------------------------------------------------------------------- */

type StateCounts = Partial<Record<LeadImportRowState, number>>;

function progressOf(entity: LeadImportEntity, counts: StateCounts | undefined): LeadImportProgress {
  const live = (state: LeadImportRowState) => counts?.[state] ?? 0;

  if (entity.state === 'ready' || entity.state === 'committing') {
    return {
      pending: live('pending'),
      created: live('created'),
      skipped: live('skipped'),
      failed: live('failed'),
      notImported: live('not_imported'),
    };
  }

  // Ended: the snapshot is the record (the staged rows may since have been cleared), and
  // whatever was never created — refused at the check, or left when it was cancelled — is
  // "not imported".
  const created = entity.snapshot?.created ?? live('created');
  const skipped = entity.snapshot?.skipped ?? live('skipped');
  const failed = entity.snapshot?.failed ?? live('failed');
  return {
    pending: 0,
    created,
    skipped,
    failed,
    notImported: Math.max(entity.totals.rows - created - skipped - failed, 0),
  };
}

function toSummary(entity: LeadImportEntity, counts: StateCounts | undefined): LeadImportSummary {
  return {
    id: entity.id,
    fileName: entity.fileName,
    fileKind: entity.fileKind,
    fileSize: entity.fileSize,
    sheetName: entity.sheetName,
    sheetNames: entity.facts.sheetNames,
    headerRow: entity.headerRow,
    state: entity.state,
    defaults: {
      assignedTo: entity.defaultAssignee,
      assignedToName: entity.defaultAssigneeName,
      source: entity.defaultSource,
      status: entity.defaultStatus,
    },
    totals: {
      rows: entity.totals.rows,
      ready: entity.totals.ready,
      warnings: entity.totals.warnings,
      errors: entity.totals.errors,
      duplicatesInFile: entity.facts.duplicatesInFile,
      duplicatesExisting: entity.facts.duplicatesExisting,
    },
    progress: progressOf(entity, counts),
    createdBy: { id: entity.createdBy, name: entity.createdByName },
    createdAt: entity.createdAt,
    expiresAt: entity.expiresAt,
    committedAt: entity.committedAt,
    completedAt: entity.completedAt,
  };
}

async function summaryOf(entity: LeadImportEntity): Promise<LeadImportSummary> {
  const counts = await countRowsByState([entity.id]);
  return toSummary(entity, counts.get(entity.id));
}

const SHOW_RAW_STATES: ReadonlySet<LeadImportRowState> = new Set(['not_imported', 'skipped', 'failed']);

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function payloadAssignee(payload: Record<string, unknown> | null): number | null {
  const value = payload?.assignedTo;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** Rows as the API returns them. Names are looked up for these rows only. */
async function toRowViews(rows: StagedRow[]): Promise<LeadImportRowView[]> {
  const assignees = rows
    .map((row) => payloadAssignee(row.payload))
    .filter((id): id is number => id !== null);
  const names = await employeeNames(assignees);

  return rows.map((row) => {
    const payload = row.payload ?? {};
    const assignedTo = payloadAssignee(row.payload);
    return {
      sheetRow: row.sheetRow,
      outcome: row.outcome,
      state: row.state,
      values: {
        customerName: payloadString(payload, 'customerName'),
        phone: payloadString(payload, 'phone'),
        alternatePhone: payloadString(payload, 'alternatePhone'),
        email: payloadString(payload, 'email'),
        city: payloadString(payload, 'city'),
        address: payloadString(payload, 'address'),
        source: payloadString(payload, 'source'),
        productInterest: payloadString(payload, 'productInterest'),
        status: payloadString(payload, 'status'),
        summaryNote: payloadString(payload, 'summaryNote'),
        assignedTo,
        assignedToName: assignedTo === null ? null : names.get(assignedTo) ?? null,
      },
      errors: row.messages.errors,
      warnings: row.messages.warnings,
      duplicateOf:
        row.duplicateOfRow !== null
          ? { kind: 'row', sheetRow: row.duplicateOfRow }
          : row.duplicateLead
            ? { kind: 'lead', ...row.duplicateLead }
            : null,
      leadId: row.leadId,
      leadReference: row.leadReference,
      resultMessage: row.resultMessage,
      raw: SHOW_RAW_STATES.has(row.state) ? row.raw : null,
    };
  });
}

async function rowsPageOf(
  importId: number,
  filter: LeadImportRowFilter,
  page: number,
  pageSize: number,
): Promise<{ rows: LeadImportRowView[]; rowsPage: RowsPage }> {
  const result = await listStagedRowsPage(importId, filter, { page, pageSize });
  return {
    rows: await toRowViews(result.items),
    rowsPage: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Expires stale drafts, clears staged rows nobody needs, and finishes off commits that
 * were abandoned mid-way (as cancelled, so their summary audit and notifications still go
 * out). Runs at the start of a preview and of the import list — there is no cron.
 *
 * Never throws: housekeeping failing must not stop anybody checking a file.
 */
async function runHousekeeping(): Promise<void> {
  try {
    const abandoned = await sweepLeadImports();
    for (const id of abandoned) {
      const entity = await findLeadImport(id);
      if (!entity || entity.state !== 'committing') continue;
      if (!(await claimCancel(id))) continue;
      await finaliseCancelled(entity, null, null, 'abandoned');
    }
  } catch (error) {
    logger.error('Lead import housekeeping failed', errorFacts(error));
  }
}

/** What is safe to log about an error: never its message, which can carry row values. */
function errorFacts(error: unknown): Record<string, unknown> {
  if (error && typeof error === 'object') {
    const detail = error as { name?: unknown; code?: unknown; errno?: unknown };
    return { name: detail.name, code: detail.code, errno: detail.errno };
  }
  return { name: typeof error };
}

/* -------------------------------------------------------------------------- */
/* Preview: reading the file                                                   */
/* -------------------------------------------------------------------------- */

function fileError(message: string): HttpError {
  return badRequest(message, { file: message });
}

async function readSheet(
  file: Express.Multer.File,
  kind: LeadImportFileKind,
  sheet: string | null,
): Promise<ParsedSheet> {
  try {
    if (kind === 'csv') return readCsv(decodeCsvText(file.buffer));

    if (kind === 'xlsx') {
      const problem = inspectZipContainer(file.buffer);
      if (problem) throw new ImportFileError(problem);
    }
    return await runParseWorker(file.buffer, kind, sheet);
  } catch (error) {
    if (error instanceof ImportFileError) throw fileError(error.message);
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Preview: columns                                                            */
/* -------------------------------------------------------------------------- */

type ColumnPlan = {
  headerRow: SheetRow;
  columns: LeadImportColumn[];
  /** The column each used field is read from. */
  fieldIndex: Map<LeadImportField, number>;
  /** The name comes from First name + Last name, there being no name column. */
  joinName: boolean;
  /** Columns appended to the notes, when that was asked for. */
  extraIndexes: number[];
  notices: string[];
};

function cellText(cell: Cell | undefined): string {
  return (cell?.s ?? '').replace(ZERO_WIDTH, '').trim();
}

function headerFields(row: SheetRow): Set<LeadImportField> {
  const fields = new Set<LeadImportField>();
  for (const cell of row.cells) {
    const text = cellText(cell);
    if (text === '') continue;
    const field = ALIAS_TO_FIELD.get(normaliseHeader(text));
    if (field) fields.add(field);
  }
  return fields;
}

/**
 * The header is the first of the first ten rows naming at least two fields, one of them
 * the phone or the name — so a title row ("Leads — October") or a blank line above the
 * table is stepped over, and a data row that happens to contain the word "Mobile" is not
 * mistaken for it.
 */
function findHeaderRow(rows: SheetRow[], manualMapping: boolean): SheetRow | null {
  for (const row of rows) {
    if (row.sheetRow > LEAD_IMPORT_LIMITS.headerScanRows) break;
    const fields = headerFields(row);
    const named = fields.has('customerName') || fields.has('firstName') || fields.has('lastName');
    if (fields.size >= 2 && (fields.has('phone') || named)) return row;
  }
  // With columns chosen by hand, the first row stands as the header.
  if (manualMapping) {
    const first = rows[0];
    if (first && first.sheetRow <= LEAD_IMPORT_LIMITS.headerScanRows) return first;
  }
  return null;
}

function describeColumn(index: number, header: string): string {
  return header ? `column ${columnLetter(index)} ("${header}")` : `column ${columnLetter(index)}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function planColumns(
  rows: SheetRow[],
  columnMap: Map<number, LeadImportField | null> | undefined,
  extraColumns: 'ignore' | 'notes',
): ColumnPlan {
  const manual = columnMap ?? new Map<number, LeadImportField | null>();
  const headerRow = findHeaderRow(rows, manual.size > 0);

  if (!headerRow) {
    throw fileError(
      'The column headings could not be found. Put them in the first row of the sheet — for example "Customer name" and "Phone" — and try again.',
    );
  }

  const dataRows = rows.filter((row) => row.sheetRow > headerRow.sheetRow);
  const width = Math.min(
    Math.max(headerRow.cells.length, ...dataRows.map((row) => row.cells.length), 0),
    LEAD_IMPORT_LIMITS.maxColumns,
  );

  for (const index of manual.keys()) {
    if (index >= width) {
      throw validationFailed({ columnMap: `There is no column ${columnLetter(index)} in this file.` });
    }
  }

  const headers = Array.from({ length: width }, (_, index) => cellText(headerRow.cells[index]));
  const fieldOf: (LeadImportField | null)[] = Array.from({ length: width }, () => null);
  const matchedBy: ('alias' | 'manual' | null)[] = Array.from({ length: width }, () => null);
  const repeated = new Set<number>();
  const fieldIndex = new Map<LeadImportField, number>();
  const notices: string[] = [];

  if (headerRow.sheetRow > 1) {
    notices.push(
      `The column headings are on row ${headerRow.sheetRow}; the rows above them are not imported.`,
    );
  }

  // 1. Choices made by hand win.
  for (const [index, field] of manual) {
    matchedBy[index] = 'manual';
    fieldOf[index] = field;
    if (field) fieldIndex.set(field, index);
  }

  // 2. Then the headers, left to right.
  for (let index = 0; index < width; index += 1) {
    if (manual.has(index)) continue;
    const header = headers[index] ?? '';
    const field = header ? ALIAS_TO_FIELD.get(normaliseHeader(header)) ?? null : null;
    if (!field) continue;

    if (!fieldIndex.has(field)) {
      fieldIndex.set(field, index);
      fieldOf[index] = field;
      matchedBy[index] = 'alias';
      continue;
    }

    // A second phone column becomes the alternate number when nothing else is.
    if ((field === 'phone' || field === 'alternatePhone') && !fieldIndex.has('alternatePhone')) {
      fieldIndex.set('alternatePhone', index);
      fieldOf[index] = 'alternatePhone';
      matchedBy[index] = 'alias';
      notices.push(
        `${capitalise(describeColumn(index, header))} is a second phone column, so it is read as Alternate phone.`,
      );
      continue;
    }

    repeated.add(index);
    notices.push(
      `${capitalise(describeColumn(index, header))} repeats ${LEAD_IMPORT_FIELD_LABELS[field]} and is not imported.`,
    );
  }

  // 3. A lone alternate-phone column ("WhatsApp no") stands in for a missing phone column.
  const alternateIndex = fieldIndex.get('alternatePhone');
  if (!fieldIndex.has('phone') && alternateIndex !== undefined && matchedBy[alternateIndex] === 'alias') {
    fieldIndex.delete('alternatePhone');
    fieldIndex.set('phone', alternateIndex);
    fieldOf[alternateIndex] = 'phone';
    notices.push(
      `${capitalise(describeColumn(alternateIndex, headers[alternateIndex] ?? ''))} is read as Phone, because the file has no other phone column.`,
    );
  }

  const hasName = fieldIndex.has('customerName');
  const joinName = !hasName && (fieldIndex.has('firstName') || fieldIndex.has('lastName'));

  if (!fieldIndex.has('phone')) {
    throw fileError('The file has no Phone column. Name a column "Phone" or "Mobile" and try again.');
  }
  if (!hasName && !joinName) {
    throw fileError(
      'The file has no Customer name column. Name a column "Customer name" or "Name" and try again.',
    );
  }

  if (hasName) {
    for (const part of ['firstName', 'lastName'] as const) {
      const index = fieldIndex.get(part);
      if (index === undefined) continue;
      fieldIndex.delete(part);
      notices.push(
        `${capitalise(describeColumn(index, headers[index] ?? ''))} is not used, because the file has a Customer name column.`,
      );
    }
  }

  const columns: LeadImportColumn[] = headers.map((header, index) => {
    const field = fieldOf[index] ?? null;
    const required =
      field === 'phone' ||
      field === 'customerName' ||
      (joinName && (field === 'firstName' || field === 'lastName'));
    return {
      index,
      letter: columnLetter(index),
      header,
      field,
      matchedBy: matchedBy[index] ?? null,
      required,
    };
  });

  // Columns that feed no field. Listed so nobody wonders where "Budget" went — or, when
  // asked for, kept in the lead's notes as "Budget: 5 lakh".
  const hasData = (index: number) => dataRows.some((row) => cellText(row.cells[index]) !== '');
  const leftOver = columns.filter(
    (column) =>
      (column.field === null || repeated.has(column.index)) &&
      column.matchedBy !== 'manual' &&
      (column.header !== '' || hasData(column.index)),
  );
  const extraIndexes =
    extraColumns === 'notes'
      ? leftOver.filter((column) => column.header !== '').map((column) => column.index)
      : [];

  const named = leftOver.map((column) =>
    column.header ? `${column.header} (${column.letter})` : `column ${column.letter} (no heading)`,
  );
  if (extraColumns === 'notes') {
    if (extraIndexes.length > 0) {
      notices.push(
        `Added to each lead's notes: ${extraIndexes
          .map((index) => `${headers[index]} (${columnLetter(index)})`)
          .join(', ')}.`,
      );
    }
    const unnamed = leftOver.filter((column) => column.header === '');
    if (unnamed.length > 0) {
      notices.push(
        `Not imported, having no heading: ${unnamed.map((column) => `column ${column.letter}`).join(', ')}.`,
      );
    }
  } else if (named.length > 0) {
    notices.push(`Not imported: ${named.join(', ')}.`);
  }

  return { headerRow, columns, fieldIndex, joinName, extraIndexes, notices };
}

/* -------------------------------------------------------------------------- */
/* Preview: rows                                                               */
/* -------------------------------------------------------------------------- */

type EmployeeMatch =
  | { kind: 'one'; employee: EmployeeRecord }
  | { kind: 'many' }
  | { kind: 'none' };

type ResolveContext = {
  defaultAssignee: EmployeeRecord | null;
  defaultSource: string;
  defaultSourceLabel: string;
  defaultStatus: LeadStatus;
  sourceByKey: Map<string, string>;
  matchEmployee: (value: string) => EmployeeMatch;
};

function buildResolveContext(
  employees: EmployeeRecord[],
  sources: LeadSourceRecord[],
  defaults: { assignee: EmployeeRecord | null; source: string; status: LeadStatus },
): ResolveContext {
  const sourceByKey = new Map<string, string>();
  for (const source of sources) {
    sourceByKey.set(normaliseHeader(source.slug), source.slug);
    sourceByKey.set(normaliseHeader(source.label), source.slug);
  }

  const byCode = new Map<string, EmployeeRecord>();
  const byEmail = new Map<string, EmployeeRecord>();
  const byName = new Map<string, EmployeeRecord[]>();
  for (const employee of employees) {
    byCode.set(employee.employeeCode.trim().toLowerCase(), employee);
    byEmail.set(employee.email.trim().toLowerCase(), employee);
    const key = normaliseHeader(employee.name);
    byName.set(key, [...(byName.get(key) ?? []), employee]);
  }

  return {
    defaultAssignee: defaults.assignee,
    defaultSource: defaults.source,
    defaultSourceLabel:
      sources.find((source) => source.slug === defaults.source)?.label ?? defaults.source,
    defaultStatus: defaults.status,
    sourceByKey,
    matchEmployee(value) {
      const lowered = value.trim().toLowerCase();
      const code = byCode.get(lowered);
      if (code) return { kind: 'one', employee: code };
      const email = byEmail.get(lowered);
      if (email) return { kind: 'one', employee: email };
      const named = byName.get(normaliseHeader(value)) ?? [];
      if (named.length === 1 && named[0]) return { kind: 'one', employee: named[0] };
      return named.length > 1 ? { kind: 'many' } : { kind: 'none' };
    },
  };
}

const STATUS_CHOICES = LEAD_STATUSES.map((status) => LEAD_STATUS_LABELS[status]).join(', ');

/** The keys of a validated row, exactly what `createLead` will be given at commit. */
type ImportPayload = {
  customerName: string;
  phone: string;
  alternatePhone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  source: string;
  productInterest: string | null;
  status: LeadStatus;
  summaryNote: string | null;
  /** Always explicit — see `evaluateRow`. */
  assignedTo: number | null;
};

type EvaluatedRow = {
  sheetRow: number;
  valid: ImportPayload | null;
  /** What the row says, for display, whether or not it is valid. */
  display: Record<string, unknown>;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  raw: (string | null)[];
  outcome: LeadImportRowOutcome;
  phoneKey: string | null;
  duplicateOfRow: number | null;
  duplicateLeadId: number | null;
};

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/**
 * One row's verdict: the cells turned into a create-lead request, resolved against the
 * live source and employee lists, and validated by the very schema the lead form uses —
 * so a row's messages are exactly what the form would have said.
 */
function evaluateRow(
  row: SheetRow,
  plan: ColumnPlan,
  context: ResolveContext,
  extraColumns: 'ignore' | 'notes',
): EvaluatedRow {
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};

  const cellFor = (field: LeadImportField): Cell | undefined => {
    const index = plan.fieldIndex.get(field);
    return index === undefined ? undefined : row.cells[index];
  };

  const read = (field: LeadImportField, reportAs: string = field): FieldText => {
    const result = cellToFieldText(field, cellFor(field));
    if (result.error && errors[reportAs] === undefined) errors[reportAs] = result.error;
    if (result.warning && warnings[reportAs] === undefined) warnings[reportAs] = result.warning;
    return result;
  };

  // --- name
  let customerName: string | null;
  if (plan.joinName) {
    const first = read('firstName', 'customerName').value;
    const last = read('lastName', 'customerName').value;
    customerName = [first, last].filter((part) => part !== null && part !== '').join(' ') || null;
  } else {
    customerName = read('customerName').value;
  }

  // --- phones
  const phoneText = read('phone');
  const alternateText = read('alternatePhone');
  const phone = phoneText.value;
  let alternatePhone = alternateText.value;

  if (phoneText.secondPhone) {
    if (alternatePhone === null && errors.alternatePhone === undefined) {
      alternatePhone = phoneText.secondPhone;
      warnings.alternatePhone = 'The phone cell held two numbers; the second was saved as the alternate phone.';
    } else {
      warnings.phone = 'The phone cell held two numbers; only the first was kept, because the alternate phone is already filled in.';
    }
  }
  if (alternateText.secondPhone && warnings.alternatePhone === undefined) {
    warnings.alternatePhone = 'The alternate phone cell held two numbers; only the first was kept.';
  }
  // Stricter than the form, which accepts "-------": a number this short is not one.
  if (alternatePhone !== null && errors.alternatePhone === undefined && digitCount(alternatePhone) < 7) {
    warnings.alternatePhone = `The alternate phone "${alternatePhone}" is too short to be a number, so it was left out.`;
    alternatePhone = null;
  }

  // --- plain text
  const email = read('email').value;
  const address = read('address').value;
  const city = read('city').value;
  const productInterest = read('productInterest').value;
  let summaryNote = read('summaryNote').value;

  if (extraColumns === 'notes' && plan.extraIndexes.length > 0) {
    const lines: string[] = [];
    for (const index of plan.extraIndexes) {
      const cell = row.cells[index] ?? BLANK_CELL;
      if (cell.k === 'blank' || cell.k === 'e') continue;
      const value = cellText(cell);
      if (value === '') continue;
      const header = plan.columns[index]?.header ?? columnLetter(index);
      lines.push(`${header}: ${value}`);
    }
    if (lines.length > 0) {
      const joined = [summaryNote, ...lines].filter((part): part is string => Boolean(part)).join('\n');
      if (joined.length > LEAD_IMPORT_LIMITS.maxCellChars) {
        summaryNote = joined.slice(0, LEAD_IMPORT_LIMITS.maxCellChars);
        warnings.summaryNote = `The notes were shortened to ${formatCount(LEAD_IMPORT_LIMITS.maxCellChars)} characters.`;
      } else {
        summaryNote = joined;
      }
    }
    if (summaryNote && errors.summaryNote === undefined && looksLikeFormula(summaryNote)) {
      errors.summaryNote = 'Text cannot start with "=", "+", "-" or "@".';
    }
  }

  // --- source: matched by code or label; unknown falls back to the default, with a note.
  // Resolving here keeps createLead's "unknown source" warning out of the log two
  // thousand times over, and stops its slug rule refusing a label like "Facebook Ads!".
  const sourceText = read('source').value;
  let source = context.defaultSource;
  if (sourceText !== null) {
    const match = context.sourceByKey.get(normaliseHeader(sourceText));
    if (match) {
      source = match;
    } else {
      warnings.source = `Source "${sourceText}" is not set up, so it was saved as ${context.defaultSourceLabel}.`;
    }
  }

  // --- status: slugs, labels and the usual variants; anything else refuses the row.
  const statusText = read('status').value;
  let status: string = context.defaultStatus;
  let statusValid = true;
  if (statusText !== null) {
    const match = STATUS_ALIASES.get(normaliseHeader(statusText));
    if (match) {
      status = match;
    } else {
      statusValid = false;
      status = statusText;
      if (errors.status === undefined) {
        errors.status = `Unknown status "${statusText}". Use one of: ${STATUS_CHOICES}.`;
      }
    }
  }
  if (statusValid && (status === 'follow_up' || status === 'callback_requested')) {
    warnings.status ??= 'No follow-up is booked by an import. Book one from the lead afterwards.';
  }

  // --- assignee. ALWAYS an explicit number or null, never absent: createLead gives a
  // lead with no assignee field to whoever is creating it, which here would hand every
  // "unassigned" row to the manager running the import.
  let assignedTo: number | null = context.defaultAssignee?.id ?? null;
  const assigneeCell = cellFor('assignedTo');
  if (assigneeCell?.k === 'e') {
    warnings.assignedTo = `The cell showed an Excel error (${assigneeCell.s ?? ''}), so the default applies.`;
  } else {
    const typed = cellText(assigneeCell);
    if (typed !== '') {
      const key = normaliseHeader(typed);
      if (typed === '-' || typed === '--' || UNASSIGNED_TOKENS.has(key)) {
        assignedTo = null;
      } else {
        const match = context.matchEmployee(typed);
        if (match.kind === 'one') {
          assignedTo = match.employee.id;
        } else {
          assignedTo = null;
          errors.assignedTo =
            match.kind === 'many'
              ? `"${typed}" matches more than one employee. Use the employee code instead.`
              : `No active employee matches "${typed}".`;
        }
      }
    }
  }

  const candidate = {
    customerName: customerName ?? undefined,
    phone: phone ?? undefined,
    alternatePhone,
    email,
    address,
    city,
    source,
    productInterest,
    status: statusValid ? status : context.defaultStatus,
    summaryNote,
    assignedTo,
  };

  const parsed = createLeadSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const [field, message] of Object.entries(toFieldErrors(parsed.error))) {
      if (errors[field] === undefined) errors[field] = message;
    }
  }

  const display: Record<string, unknown> = {
    customerName,
    phone,
    alternatePhone,
    email,
    address,
    city,
    source,
    productInterest,
    status,
    summaryNote,
    assignedTo,
  };

  const valid: ImportPayload | null =
    parsed.success && Object.keys(errors).length === 0
      ? {
          customerName: parsed.data.customerName,
          phone: parsed.data.phone,
          alternatePhone: parsed.data.alternatePhone,
          email: parsed.data.email,
          address: parsed.data.address,
          city: parsed.data.city,
          source: parsed.data.source,
          productInterest: parsed.data.productInterest,
          status: parsed.data.status,
          summaryNote: parsed.data.summaryNote,
          assignedTo,
        }
      : null;

  return {
    sheetRow: row.sheetRow,
    valid,
    display: valid ?? display,
    errors,
    warnings,
    raw: plan.columns.map((column) => {
      const text = cellText(row.cells[column.index]);
      return text === '' ? null : text;
    }),
    outcome: valid ? (Object.keys(warnings).length > 0 ? 'warning' : 'ready') : 'error',
    phoneKey: null,
    duplicateOfRow: null,
    duplicateLeadId: null,
  };
}

/**
 * Duplicates, among rows that are otherwise valid: against the active leads first (the
 * row would be refused at commit anyway, so say so now), then within the file, where the
 * first VALID occurrence of a number is the one that imports.
 */
async function markDuplicates(rows: EvaluatedRow[]): Promise<void> {
  const keys = rows.flatMap((row) => (row.valid ? [phoneMatchKey(row.valid.phone)] : []));
  const existing = await findActiveLeadsByPhoneKeys(keys);
  const firstRowFor = new Map<string, number>();

  for (const row of rows) {
    if (!row.valid) continue;
    const key = phoneMatchKey(row.valid.phone);
    row.phoneKey = key;

    const lead = key.length >= 6 ? existing.get(key) : undefined;
    if (lead) {
      row.outcome = 'duplicate_existing';
      row.duplicateLeadId = lead.id;
      continue;
    }

    const first = firstRowFor.get(key);
    if (first !== undefined) {
      row.outcome = 'duplicate_in_file';
      row.duplicateOfRow = first;
      continue;
    }
    firstRowFor.set(key, row.sheetRow);
  }
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Checks a file and stages its rows. Writes nothing outside the two import tables — no
 * lead, activity, notification or audit row — so checking a file is always safe.
 */
export async function previewLeadImport(
  file: Express.Multer.File,
  input: LeadImportPreviewInput,
  actor: Actor,
): Promise<LeadImportPreviewResult> {
  await runHousekeeping();

  const kind = detectFileKind(file.originalname);
  if (!kind) throw fileError('Choose an Excel (.xlsx or .xls) or CSV file.');

  const [employees, sources] = await Promise.all([listAssignableEmployees(), listLeadSources(true)]);

  let defaultAssignee: EmployeeRecord | null = null;
  if (input.defaultAssignedTo !== null) {
    defaultAssignee = employees.find((employee) => employee.id === input.defaultAssignedTo) ?? null;
    if (!defaultAssignee) throw validationFailed({ defaultAssignedTo: 'Choose an active employee.' });
  }

  let defaultSource: string;
  if (input.defaultSource !== undefined) {
    if (!sources.some((source) => source.slug === input.defaultSource)) {
      throw validationFailed({ defaultSource: 'Choose an active lead source.' });
    }
    defaultSource = input.defaultSource;
  } else {
    defaultSource =
      sources.find((source) => source.slug === 'manual')?.slug ?? sources[0]?.slug ?? 'other';
  }

  const sheet = await readSheet(file, kind, input.sheet ?? null);
  if (sheet.rows.length === 0) throw fileError('The file has no rows to import.');

  const plan = planColumns(sheet.rows, input.columnMap, input.extraColumns);
  const dataRows = sheet.rows.filter((row) => row.sheetRow > plan.headerRow.sheetRow);

  if (dataRows.length > LEAD_IMPORT_LIMITS.maxRows || sheet.moreRows) {
    throw fileError(
      `The file has more than ${formatCount(LEAD_IMPORT_LIMITS.maxRows)} rows. Split it into files of up to ${formatCount(LEAD_IMPORT_LIMITS.maxRows)} rows and import each one.`,
    );
  }
  if (dataRows.length === 0) throw fileError('The file has no rows to import.');

  const context = buildResolveContext(employees, sources, {
    assignee: defaultAssignee,
    source: defaultSource,
    status: input.defaultStatus,
  });

  const evaluated = dataRows.map((row) => evaluateRow(row, plan, context, input.extraColumns));
  await markDuplicates(evaluated);

  const count = (outcome: LeadImportRowOutcome) =>
    evaluated.filter((row) => row.outcome === outcome).length;
  const duplicatesInFile = count('duplicate_in_file');
  const duplicatesExisting = count('duplicate_existing');

  const sha256 = createHash('sha256').update(file.buffer).digest('hex');
  const notices = [...plan.notices];

  const earlier = await findImportByHash(sha256, 0);
  if (earlier) {
    const when = formatCompanyDateTime(earlier.createdAt);
    const who = earlier.createdByName ?? 'someone';
    notices.unshift(
      earlier.state === 'committing'
        ? `This file is already being imported, started by ${who} on ${when}.`
        : `This file was imported before, by ${who} on ${when}${
            earlier.createdCount !== null ? ` (${formatCount(earlier.createdCount)} leads created)` : ''
          }. Rows whose numbers were imported then show as duplicates.`,
    );
  }

  const facts: ImportFacts = {
    columns: plan.columns,
    sheetNames: sheet.sheetNames,
    notices,
    duplicatesInFile,
    duplicatesExisting,
  };

  const staged: InsertStagedRow[] = evaluated.map((row) => ({
    sheetRow: row.sheetRow,
    outcome: row.outcome,
    state: row.outcome === 'ready' || row.outcome === 'warning' ? 'pending' : 'not_imported',
    phoneKey: row.phoneKey,
    payload: row.display,
    raw: row.raw,
    messages: { errors: row.errors, warnings: row.warnings },
    duplicateOfRow: row.duplicateOfRow,
    duplicateLeadId: row.duplicateLeadId,
    clientUuid: randomUUID(),
  }));

  const baseName = safeFilename(file.originalname);
  const fileName = baseName && baseName !== path.extname(baseName) ? baseName : `leads.${kind}`;

  // One short transaction over the import tables only: the draft is all there or not at
  // all, and replacing an earlier draft happens in the same breath.
  const importId = await withTransaction(async (connection) => {
    if (input.replaces !== undefined) {
      await discardReadyDraftTx(connection, input.replaces, actor.id);
    }
    const id = await insertLeadImportTx(connection, {
      createdBy: actor.id,
      fileName,
      fileKind: kind,
      fileSha256: sha256,
      fileSize: file.size,
      sheetName: sheet.sheetName,
      headerRow: plan.headerRow.sheetRow,
      facts,
      defaultAssignee: defaultAssignee?.id ?? null,
      defaultSource,
      defaultStatus: input.defaultStatus,
      totals: {
        rows: evaluated.length,
        ready: count('ready'),
        warnings: count('warning'),
        errors: count('error'),
        duplicates: duplicatesInFile + duplicatesExisting,
      },
    });
    await insertStagedRowsTx(connection, id, staged);
    return id;
  });

  const entity = await findLeadImport(importId);
  if (!entity) throw notFound('Import not found.');

  const { rows, rowsPage } = await rowsPageOf(importId, {}, 1, LEAD_IMPORT_LIMITS.previewPageSize);

  return {
    import: await summaryOf(entity),
    columns: entity.facts.columns,
    rows,
    rowsPage,
    notices: entity.facts.notices,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading imports                                                             */
/* -------------------------------------------------------------------------- */

/** An unconfirmed draft past its lifetime is expired on read, so a screen sees the truth. */
async function loadImport(importId: number): Promise<LeadImportEntity> {
  let entity = await findLeadImport(importId);
  if (!entity) throw notFound('Import not found.');

  if (entity.state === 'ready' && Date.parse(entity.expiresAt) < Date.now()) {
    await expireDraft(importId);
    entity = await findLeadImport(importId);
    if (!entity) throw notFound('Import not found.');
  }
  return entity;
}

/** One import with one page of its rows. Any manager may look. */
export async function getLeadImport(
  importId: number,
  query: LeadImportDetailQuery,
): Promise<LeadImportDetailResult> {
  const entity = await loadImport(importId);
  const counts = (await countRowsByState([importId])).get(importId);
  const staged = Object.values(counts ?? {}).reduce((sum, value) => sum + (value ?? 0), 0);

  const { rows, rowsPage } = await rowsPageOf(
    importId,
    { outcome: query.outcome, state: query.state },
    query.page,
    query.pageSize,
  );

  return {
    import: toSummary(entity, counts),
    columns: entity.facts.columns,
    rows,
    rowsPage,
    notices: entity.facts.notices,
    rowsPurged: entity.totals.rows > 0 && staged === 0,
  };
}

/** Imports, newest first. */
export async function listLeadImports(
  query: LeadImportListQuery,
  actor: Actor,
): Promise<{ items: LeadImportSummary[]; page: number; pageSize: number; total: number; totalPages: number }> {
  await runHousekeeping();

  const result = await listLeadImportsPage(query, actor.id);
  const counts = await countRowsByState(result.items.map((entity) => entity.id));

  return {
    items: result.items.map((entity) => toSummary(entity, counts.get(entity.id))),
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totalPages: result.totalPages,
  };
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                      */
/* -------------------------------------------------------------------------- */

/** Running or stopping an import belongs to the person who started it, or an admin. */
function assertMayRun(entity: LeadImportEntity, actor: Actor): void {
  if (entity.createdBy === actor.id || hasRole(actor, 'admin')) return;
  throw forbidden('Only the person who started this import, or an administrator, can do that.');
}

function closedError(entity: LeadImportEntity): HttpError {
  return conflict(
    entity.state === 'expired'
      ? 'This check has expired. Check the file again to import it.'
      : entity.state === 'completed'
        ? 'This import has already finished.'
        : 'This import was cancelled. Check the file again to import it.',
    'import_closed',
  );
}

async function finishedResult(entity: LeadImportEntity): Promise<LeadImportCommitResult> {
  return { import: await summaryOf(entity), processed: 0, remaining: 0, done: true, rows: [] };
}

const LOCK_CONTENTION_ERRNOS = new Set([1213, 1205]);

type RowResult =
  | { state: 'created' | 'skipped' | 'failed'; leadId: number | null; message: string | null }
  | { state: 'retry' };

/**
 * Creates one staged row through `createLead`, and says what happened. Never throws for a
 * row that cannot be imported — that is a result, collected, as bulk assignment collects
 * them — only for the database being unreachable.
 */
async function createRow(entity: LeadImportEntity, row: PendingRow, actor: Actor): Promise<RowResult> {
  try {
    if (!row.payload) throw new Error('Staged row has no payload.');

    // Re-validated through the authoritative schema: the staged JSON is not trusted just
    // because this server wrote it.
    const input = createLeadSchema.parse({ ...row.payload, clientUuid: row.clientUuid });
    const created = await createLead(
      { ...input, assignedTo: payloadAssignee(row.payload), clientUuid: row.clientUuid },
      actor,
      null,
      {
        origin: { kind: 'import', importId: entity.id, sheetRow: row.sheetRow },
        notifyAssignee: false,
        audit: false,
      },
    );
    return { state: 'created', leadId: created.lead.id, message: null };
  } catch (error) {
    // A refusal createLead explains — a number taken since the check, an owner
    // deactivated since — is the row's result, in createLead's own words.
    if (error instanceof HttpError && error.status < 500) {
      return { state: 'skipped', leadId: null, message: error.message };
    }
    if (error instanceof ZodError) {
      return {
        state: 'skipped',
        leadId: null,
        message: error.issues[0]?.message ?? 'This row no longer passes the lead checks.',
      };
    }

    // Anything else: perhaps the lead was created and only the answer was lost (a
    // concurrent attempt won on the note's unique client UUID, say). If so, it is created.
    const existing = await findLeadByClientUuid(row.clientUuid).catch(() => null);
    if (existing) return { state: 'created', leadId: existing.id, message: null };

    // Lost a lock race: the row is untouched, so leave it pending for the next batch.
    const errno = Number((error as { errno?: unknown } | null)?.errno);
    if (LOCK_CONTENTION_ERRNOS.has(errno)) return { state: 'retry' };

    logger.error('Lead import row could not be saved', {
      importId: entity.id,
      sheetRow: row.sheetRow,
      ...errorFacts(error),
    });
    return {
      state: 'failed',
      leadId: null,
      message: 'This row could not be saved. Import it again from the rows to fix.',
    };
  }
}

/**
 * Imports the next batch of rows (at most 250), and finishes the import when none are
 * left. Call it until `done`.
 *
 * Safe to call again at any point: after a timeout, a dropped connection, a double click
 * or from a second window — the lock refuses a concurrent batch with 409 `import_busy`,
 * and a replayed row returns the lead it already created.
 */
export async function commitLeadImportBatch(
  importId: number,
  input: LeadImportCommitInput,
  actor: Actor,
  ipAddress: string | null,
): Promise<LeadImportCommitResult> {
  const entity = await findLeadImport(importId);
  if (!entity) throw notFound('Import not found.');
  assertMayRun(entity, actor);

  if (entity.state === 'completed') return finishedResult(entity);
  if (entity.state === 'cancelled' || entity.state === 'expired') throw closedError(entity);
  if (entity.state === 'ready' && Date.parse(entity.expiresAt) < Date.now()) {
    await expireDraft(importId);
    throw closedError({ ...entity, state: 'expired' });
  }

  // The default assignee has to be able to take leads. Checked before anything is
  // written, so the person can cancel and check the file again with another default.
  if (entity.defaultAssignee !== null) {
    const assignee = await findEmployee(entity.defaultAssignee);
    if (!assignee || !assignee.isActive || assignee.approvalStatus !== 'approved') {
      throw badRequest(
        `The default assignee${assignee ? `, ${assignee.name},` : ''} was deactivated, so the leads meant for them cannot be assigned. Cancel this import and check the file again.`,
      );
    }
  }

  if (!(await claimCommitLock(importId))) {
    const current = await findLeadImport(importId);
    if (!current) throw notFound('Import not found.');
    if (current.state === 'completed') return finishedResult(current);
    if (current.state === 'cancelled' || current.state === 'expired') throw closedError(current);
    if (current.state === 'ready') {
      // The only reason a ready draft cannot be claimed: its time ran out.
      await expireDraft(importId);
      throw closedError({ ...current, state: 'expired' });
    }
    throw conflict('This import is already running in another window.', 'import_busy');
  }

  const started = Date.now();
  const processed: number[] = [];

  try {
    const rows = await nextPendingRows(importId, input.batchSize);
    let sinceHeartbeat = 0;

    for (const row of rows) {
      // Stop starting rows once the time budget is spent, so the request ends well
      // inside the proxy's timeout; the client simply calls again.
      if (Date.now() - started > LEAD_IMPORT_LIMITS.batchTimeBudgetMs) break;

      const result = await createRow(entity, row, actor);
      if (result.state === 'retry') break;

      await recordRowResult(row.id, result);
      processed.push(row.id);

      sinceHeartbeat += 1;
      if (sinceHeartbeat >= LEAD_IMPORT_LIMITS.heartbeatEveryRows) {
        await extendCommitLock(importId);
        sinceHeartbeat = 0;
      }
    }
  } catch (error) {
    await releaseCommitLock(importId).catch(() => undefined);
    throw error;
  }

  const counts = (await countRowsByState([importId])).get(importId) ?? {};
  const remaining = counts.pending ?? 0;
  let done = false;

  if (remaining === 0) {
    done = await finaliseCompleted(entity, counts, actor, ipAddress);
  } else {
    await releaseCommitLock(importId);
  }

  const current = (await findLeadImport(importId)) ?? entity;
  return {
    import: toSummary(current, counts),
    processed: processed.length,
    remaining,
    done: done || current.state === 'completed',
    rows: await toRowViews(await findStagedRowsByIds(processed)),
  };
}

/* -------------------------------------------------------------------------- */
/* Finishing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One summary notification per employee who received leads, instead of one per lead. A
 * single lead links to it; several open the list. Worded for a telecaller's phone: no
 * file name, no mention of an import.
 */
async function notifyAssignees(entity: LeadImportEntity, fallbackName: string | null): Promise<void> {
  const assignees = await importedLeadsByAssignee(entity.id);
  if (assignees.length === 0) return;

  const by = entity.createdByName ?? fallbackName;
  await queueNotifications(
    assignees.map((assignee) => ({
      userId: assignee.userId,
      kind: 'lead_assigned' as const,
      title:
        assignee.total === 1 ? 'New lead assigned' : `${formatCount(assignee.total)} new leads assigned`,
      body: by ? `Added by ${by}.` : null,
      leadId: assignee.total === 1 ? assignee.firstLeadId : null,
    })),
  );
}

function auditMeta(
  entity: LeadImportEntity,
  counts: { created: number; skipped: number; failed: number },
): Record<string, unknown> {
  return {
    fileName: entity.fileName,
    sha256: entity.fileSha256,
    totals: {
      rows: entity.totals.rows,
      ready: entity.totals.ready,
      warnings: entity.totals.warnings,
      errors: entity.totals.errors,
      duplicatesInFile: entity.facts.duplicatesInFile,
      duplicatesExisting: entity.facts.duplicatesExisting,
    },
    created: counts.created,
    skipped: counts.skipped,
    failed: counts.failed,
    defaultAssignee: entity.defaultAssignee,
    defaultSource: entity.defaultSource,
    defaultStatus: entity.defaultStatus,
  };
}

function finalCounts(counts: StateCounts): { created: number; skipped: number; failed: number } {
  return {
    created: counts.created ?? 0,
    skipped: counts.skipped ?? 0,
    failed: counts.failed ?? 0,
  };
}

/** The batch that leaves no pending row closes the import: the snapshot, ONE audit row, the notifications. */
async function finaliseCompleted(
  entity: LeadImportEntity,
  counts: StateCounts,
  actor: Actor,
  ipAddress: string | null,
): Promise<boolean> {
  const final = finalCounts(counts);
  if (!(await completeImport(entity.id, final))) return false;

  await recordAudit({
    actor,
    action: 'leads_imported',
    entityType: 'lead_import',
    entityId: entity.id,
    summary: `Imported ${formatCount(final.created)} lead(s) from ${entity.fileName} (${formatCount(final.skipped)} skipped, ${formatCount(final.failed)} failed)`,
    meta: auditMeta(entity, final),
    ipAddress,
  });
  await notifyAssignees(entity, actor.name);
  return true;
}

/**
 * An import that has just been moved to `cancelled`: its final counts, its unimported
 * rows cleared, and — when the commit had started — one audit row and the notifications
 * for the leads already created, which are kept.
 */
async function finaliseCancelled(
  entity: LeadImportEntity,
  actor: Actor | null,
  ipAddress: string | null,
  reason: 'cancelled' | 'abandoned',
): Promise<void> {
  const counts = (await countRowsByState([entity.id])).get(entity.id) ?? {};
  const final = finalCounts(counts);
  await finishCancelledImport(entity.id, final);

  // A draft nobody confirmed changed nothing; only a started commit is worth a record.
  if (entity.state !== 'committing' && final.created === 0) return;

  await recordAudit({
    actor,
    action: 'lead_import_cancelled',
    entityType: 'lead_import',
    entityId: entity.id,
    summary:
      reason === 'abandoned'
        ? `Stopped the import of ${entity.fileName} after a day without progress: ${formatCount(final.created)} lead(s) imported`
        : `Cancelled the import of ${entity.fileName}: ${formatCount(final.created)} lead(s) imported (${formatCount(final.skipped)} skipped, ${formatCount(final.failed)} failed)`,
    meta: { ...auditMeta(entity, final), reason },
    ipAddress,
  });
  await notifyAssignees(entity, actor?.name ?? null);
}

/**
 * Stops an import. Leads already created are kept; the rows not yet imported are
 * dropped. Already cancelled: answered as it is. Finished or expired: 409.
 */
export async function cancelLeadImport(
  importId: number,
  actor: Actor,
  ipAddress: string | null,
): Promise<{ import: LeadImportSummary }> {
  const entity = await findLeadImport(importId);
  if (!entity) throw notFound('Import not found.');
  assertMayRun(entity, actor);

  if (entity.state === 'cancelled') return { import: await summaryOf(entity) };
  if (entity.state === 'completed' || entity.state === 'expired') throw closedError(entity);

  if (!(await claimCancel(importId))) {
    const current = await findLeadImport(importId);
    if (!current) throw notFound('Import not found.');
    if (current.state === 'cancelled') return { import: await summaryOf(current) };
    if (current.state === 'completed' || current.state === 'expired') throw closedError(current);
    throw conflict(
      'This import is running in another window right now. Try again in a moment.',
      'import_busy',
    );
  }

  await finaliseCancelled(entity, actor, ipAddress, 'cancelled');

  const current = (await findLeadImport(importId)) ?? entity;
  return { import: await summaryOf(current) };
}

/* -------------------------------------------------------------------------- */
/* Template                                                                    */
/* -------------------------------------------------------------------------- */

const TEMPLATE_COLUMNS: { header: string; width: number; text?: boolean }[] = [
  { header: 'Customer name', width: 26 },
  { header: 'Phone', width: 18, text: true },
  { header: 'Alternate phone', width: 18, text: true },
  { header: 'Email', width: 28 },
  { header: 'City', width: 16 },
  { header: 'Address', width: 36 },
  { header: 'Source', width: 18 },
  { header: 'Product interest', width: 22 },
  { header: 'Status', width: 20 },
  { header: 'Assigned to', width: 22 },
  { header: 'Notes', width: 40 },
];

export const LEAD_IMPORT_TEMPLATE_FILE = 'jmk-lead-import-template.xlsx';
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The blank template: a "Leads" sheet with the headings only — no example rows, so nothing
 * fake can ever be imported — and a "How to fill" sheet listing the fields, the limits,
 * the statuses and the sources that are active right now.
 *
 * The Phone and Alternate phone cells of rows 2–2001 are created empty and formatted as
 * Text, so Excel keeps 919876543210 as typed instead of showing 9.19877E+11 and losing
 * the last digits. Employee codes are deliberately not listed: the file travels.
 */
export async function buildLeadImportTemplate(): Promise<Buffer> {
  const XLSX = await import('xlsx');
  const sources = await listLeadSources(true);
  const maxRows = LEAD_IMPORT_LIMITS.maxRows;

  const leads = XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS.map((column) => column.header)]);
  TEMPLATE_COLUMNS.forEach((column, c) => {
    if (!column.text) return;
    for (let r = 1; r <= maxRows; r += 1) {
      leads[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: '', z: '@' };
    }
  });
  leads['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: maxRows, c: TEMPLATE_COLUMNS.length - 1 },
  });
  leads['!cols'] = TEMPLATE_COLUMNS.map((column) => ({ wch: column.width }));

  const guide: string[][] = [
    ['Importing leads', 'Fill in one lead per row on the "Leads" sheet. Keep the headings in the first row.'],
    ['Limits', `Up to ${formatCount(maxRows)} rows and 5 MB per file.`],
    ['Required', 'Customer name and Phone.'],
    ['Optional', 'Alternate phone, Email, City, Address, Source, Product interest, Status, Assigned to, Notes.'],
    [
      'Phone',
      'Type the number as it is, for example 98765 43210 or +91 98765 43210. The Phone and Alternate phone columns are formatted as Text so Excel keeps every digit. Each number can belong to only one active lead: a row whose number is already taken is skipped.',
    ],
    ['Status', 'One of the statuses below. Leave it empty to use the status chosen when importing.'],
    ['Source', 'One of the sources below, by name or code. Leave it empty to use the source chosen when importing.'],
    [
      'Assigned to',
      'The employee code, email address or exact name of an active employee. Write "Unassigned" to leave a lead unassigned. Leave it empty to use the person chosen when importing.',
    ],
    ['Notes', `Anything else about the lead, up to ${formatCount(LEAD_IMPORT_LIMITS.maxCellChars)} characters.`],
    [],
    ['Statuses', 'Code'],
    ...LEAD_STATUSES.map((status) => [LEAD_STATUS_LABELS[status], status]),
    [],
    ['Sources', 'Code'],
    ...sources.map((source) => [source.label, source.slug]),
  ];
  const help = XLSX.utils.aoa_to_sheet(guide);
  help['!cols'] = [{ wch: 22 }, { wch: 100 }];

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, leads, 'Leads');
  XLSX.utils.book_append_sheet(book, help, 'How to fill');

  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}

/* -------------------------------------------------------------------------- */
/* Rows to fix                                                                 */
/* -------------------------------------------------------------------------- */

/** Rows that need attention: never imported, or refused or failed at commit. */
const ROWS_TO_FIX: LeadImportRowState[] = ['not_imported', 'skipped', 'failed'];

/**
 * A CSV value. Quoted when needed, and — because this file is made to be opened in
 * Excel — a value that would run as a formula is prefixed with an apostrophe. The import
 * strips a leading apostrophe from phone cells, so the file goes straight back in.
 */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function problemText(row: StagedRow): string {
  const parts = [...Object.values(row.messages.errors)];
  if (row.duplicateOfRow !== null) parts.push(`Same number as row ${row.duplicateOfRow}.`);
  if (row.duplicateLead) {
    const owner = row.duplicateLead.assignedToName
      ? `, assigned to ${row.duplicateLead.assignedToName}`
      : '';
    parts.push(
      `Already used by ${row.duplicateLead.customerName} (${row.duplicateLead.reference})${owner}.`,
    );
  }
  if (row.resultMessage) parts.push(row.resultMessage);
  parts.push(...Object.values(row.messages.warnings));
  return parts.join(' ');
}

/**
 * The rows that were not imported — or any filtered set — as a CSV of the ORIGINAL
 * columns plus a "Problem" column, to fix in Excel and import again. Built on the server
 * because the screen holds one page of rows at a time, never the whole file.
 */
export async function buildLeadImportRowsCsv(
  importId: number,
  query: LeadImportRowsCsvQuery,
): Promise<{ fileName: string; csv: string }> {
  const entity = await loadImport(importId);
  const filter: LeadImportRowFilter =
    query.outcome || query.state
      ? { outcome: query.outcome, state: query.state }
      : { state: ROWS_TO_FIX };

  const rows = await listStagedRowsForExport(importId, filter);
  const columns = entity.facts.columns;

  const lines = [
    [...columns.map((column) => column.header || `Column ${column.letter}`), 'Problem'],
    ...rows.map((row) => [
      ...columns.map((_column, index) => row.raw?.[index] ?? ''),
      problemText(row),
    ]),
  ];

  const base =
    path
      .basename(entity.fileName, path.extname(entity.fileName))
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'leads';

  return {
    fileName: `${base}-rows-to-fix.csv`,
    // A BOM so Excel reads the file as UTF-8 and non-English names survive.
    csv: `﻿${lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n')}\r\n`,
  };
}
