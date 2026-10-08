import { z } from 'zod';
import { LEAD_STATUSES, paginationSchema, type LeadStatus } from '../shared.schema';

/**
 * Importing leads from a spreadsheet (spec: Admin Module 4).
 *
 * An import is two steps. The file is checked and every row given a verdict — the
 * preview, which writes nothing but staging rows — and then the good rows are created in
 * small batches through `createLead`, the only lead write path, so every rule a single
 * create obeys (owner checks, one active lead per number, the activity trail) holds for
 * every imported row too. See migration 026 for why the rows are staged between the two.
 */

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

const MB = 1024 * 1024;

/**
 * Every bound in one place, because several of them only make sense together.
 *
 * - 5 MB matches the resume limit and fits under the proxies' body caps (nginx 12m, the
 *   Hostinger variant 6M) including multipart framing. A 2,000-row lead sheet is
 *   typically 60–600 KB.
 * - 2,000 data rows bounds the staging size and the total commit time (roughly 10–30 s,
 *   spread over many requests).
 * - A batch stops starting new rows after 10 s, so each commit request finishes well
 *   inside the proxy's 30 s read timeout; the 60 s lock outlives any batch, and is
 *   extended every 25 rows anyway.
 * - The parse runs in a worker thread with its own heap and a 15 s deadline — the only
 *   real guarantee against a hostile workbook, which can otherwise exhaust the memory or
 *   block the single event loop the whole office's API traffic shares.
 */
export const LEAD_IMPORT_LIMITS = {
  maxBytes: 5 * MB,
  maxRows: 2000,
  maxColumns: 60,
  maxCellChars: 4000,
  /** The header must be within the first ten rows of the sheet. */
  headerScanRows: 10,
  previewPageSize: 50,
  rowsPageSizeMax: 100,
  batchDefault: 100,
  batchMax: 250,
  batchTimeBudgetMs: 10_000,
  lockSeconds: 60,
  heartbeatEveryRows: 25,
  draftTtlHours: 24,
  /** A commit nobody has touched for this long is finished off as cancelled. */
  abandonedHours: 24,
  /** Staged rows (customer names and numbers) are deleted this long after the end. */
  retentionDays: 90,
  parseTimeoutMs: 15_000,
  parseHeapMb: 256,
  maxConcurrentParses: 2,
  zip: {
    maxEntries: 500,
    maxEntryBytes: 50 * MB,
    maxTotalBytes: 100 * MB,
    /** A ratio above this is suspicious only for an entry big enough to matter. */
    maxRatio: 200,
    ratioMinBytes: 10 * MB,
  },
} as const;

/**
 * Rows read from the top of a sheet before the row count is decided: the header window,
 * the row limit, and one more so "more than the limit" can be seen at all.
 */
export const LEAD_IMPORT_ROW_CAP =
  LEAD_IMPORT_LIMITS.headerScanRows + LEAD_IMPORT_LIMITS.maxRows + 1;

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The lead fields a column can be read into. `firstName` and `lastName` exist only to be
 * joined into `customerName` when a sheet splits the name.
 */
export const LEAD_IMPORT_FIELDS = [
  'customerName',
  'firstName',
  'lastName',
  'phone',
  'alternatePhone',
  'email',
  'address',
  'city',
  'source',
  'productInterest',
  'status',
  'summaryNote',
  'assignedTo',
] as const;
export type LeadImportField = (typeof LEAD_IMPORT_FIELDS)[number];

export const LEAD_IMPORT_FILE_KINDS = ['xlsx', 'xls', 'csv'] as const;
export type LeadImportFileKind = (typeof LEAD_IMPORT_FILE_KINDS)[number];

export const LEAD_IMPORT_STATES = ['ready', 'committing', 'completed', 'cancelled', 'expired'] as const;
export type LeadImportState = (typeof LEAD_IMPORT_STATES)[number];

/** The verdict a row was given when the file was checked. Never changes afterwards. */
export const LEAD_IMPORT_ROW_OUTCOMES = [
  'ready',
  'warning',
  'error',
  'duplicate_in_file',
  'duplicate_existing',
] as const;
export type LeadImportRowOutcome = (typeof LEAD_IMPORT_ROW_OUTCOMES)[number];

/**
 * What has happened to a row since. Ready and warning rows start `pending`; errors and
 * duplicates start `not_imported` and stay that way.
 */
export const LEAD_IMPORT_ROW_STATES = ['pending', 'not_imported', 'created', 'skipped', 'failed'] as const;
export type LeadImportRowState = (typeof LEAD_IMPORT_ROW_STATES)[number];

/** How a field is named in messages an admin reads. */
export const LEAD_IMPORT_FIELD_LABELS: Record<LeadImportField, string> = {
  customerName: 'Customer name',
  firstName: 'First name',
  lastName: 'Last name',
  phone: 'Phone',
  alternatePhone: 'Alternate phone',
  email: 'Email',
  address: 'Address',
  city: 'City',
  source: 'Source',
  productInterest: 'Product interest',
  status: 'Status',
  summaryNote: 'Notes',
  assignedTo: 'Assigned to',
};

/**
 * The status labels both clients show, mirrored from the admin web's LEAD_STATUS_LABELS.
 *
 * A sheet written by a person uses the words on the screen, not the slugs, and the
 * create schema accepts only slugs — so without this a "Follow-up required" column fails
 * every row. Also what the "How to fill" sheet of the template lists.
 */
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  not_interested: 'Not interested',
  follow_up: 'Follow-up required',
  callback_requested: 'Callback requested',
  converted: 'Converted',
  lost: 'Lost',
  invalid_number: 'Invalid number',
  not_reachable: 'Not reachable',
  walked_in: 'Walked in',
};

/* -------------------------------------------------------------------------- */
/* Matching what a person typed                                                */
/* -------------------------------------------------------------------------- */

/** Zero-width characters that ride along with text copied from web pages and chats. */
export const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/**
 * A header (or a status, source or "nothing" value) reduced to what a person meant.
 *
 * `Mobile No.` → `mobile no`, `E-mail` → `e mail`, `Phone (WhatsApp)` → `phone`,
 * `FOLLOW-UP REQUIRED` → `follow up required`. NFKC first so full-width and compatibility
 * forms from other keyboards compare equal to the plain ones.
 */
export function normaliseHeader(value: string): string {
  return value
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[*:#.]/g, ' ')
    .replace(/[_\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Header names, stored already normalised. Each alias belongs to exactly one field (the
 * map below refuses to build otherwise).
 *
 * Includes the headers of the admin web's own lead export — Customer, Alternate,
 * "Interested in", "Assigned to" — so an export can be imported straight back. Every row
 * of it then shows as a duplicate, which is the correct answer.
 */
export const HEADER_ALIASES: Record<LeadImportField, readonly string[]> = {
  customerName: [
    'customer name', 'customer', 'name', 'full name', 'lead name', 'client name', 'client',
    'contact name', 'student name', 'candidate name', 'enquirer name', 'prospect name',
  ],
  firstName: ['first name', 'firstname', 'given name'],
  lastName: ['last name', 'lastname', 'surname', 'family name'],
  phone: [
    'phone', 'phone number', 'phone no', 'mobile', 'mobile number', 'mobile no', 'mob',
    'mob no', 'cell', 'cell number', 'contact number', 'contact no', 'telephone', 'tel',
    'primary phone', 'primary number', 'phone 1', 'mobile 1',
  ],
  alternatePhone: [
    'alternate phone', 'alternate', 'alternate number', 'alternate no', 'alternative number',
    'alt phone', 'alt number', 'secondary phone', 'secondary number', 'phone 2', 'mobile 2',
    'other phone', 'other number', 'landline', 'whatsapp', 'whatsapp number', 'whatsapp no',
  ],
  email: ['email', 'e mail', 'email address', 'email id', 'e mail id', 'mail', 'mail id'],
  address: [
    'address', 'full address', 'street address', 'address line 1', 'residential address',
    'postal address',
  ],
  city: ['city', 'town', 'location', 'district', 'place'],
  source: ['source', 'lead source', 'source of lead', 'channel', 'medium'],
  productInterest: [
    'product interest', 'product', 'interested in', 'interest', 'course', 'service',
    'program', 'programme',
  ],
  status: ['status', 'lead status', 'stage'],
  summaryNote: [
    'notes', 'note', 'remarks', 'remark', 'comments', 'comment', 'requirement',
    'requirements', 'summary', 'description', 'details', 'latest note', 'last note',
  ],
  assignedTo: [
    'assigned to', 'assignee', 'assigned', 'owner', 'telecaller', 'agent', 'employee',
    'employee code', 'caller',
  ],
};

export const ALIAS_TO_FIELD: ReadonlyMap<string, LeadImportField> = (() => {
  const map = new Map<string, LeadImportField>();
  for (const field of LEAD_IMPORT_FIELDS) {
    for (const alias of HEADER_ALIASES[field]) {
      const key = normaliseHeader(alias);
      const taken = map.get(key);
      if (taken && taken !== field) {
        throw new Error(`Header alias "${alias}" is claimed by both ${taken} and ${field}.`);
      }
      map.set(key, field);
    }
  }
  return map;
})();

/**
 * Status words, normalised, to the slug they mean: the slugs themselves, the labels the
 * screens show, and the variants people actually type.
 */
export const STATUS_ALIASES: ReadonlyMap<string, LeadStatus> = (() => {
  const map = new Map<string, LeadStatus>();
  for (const status of LEAD_STATUSES) {
    map.set(normaliseHeader(status), status);
    map.set(normaliseHeader(LEAD_STATUS_LABELS[status]), status);
  }
  const variants: [string, LeadStatus][] = [
    ['follow up', 'follow_up'],
    ['followup', 'follow_up'],
    ['follow up needed', 'follow_up'],
    ['call back', 'callback_requested'],
    ['callback', 'callback_requested'],
    ['call back requested', 'callback_requested'],
    ['walk in', 'walked_in'],
    ['walkin', 'walked_in'],
    ['wrong number', 'invalid_number'],
    ['invalid', 'invalid_number'],
    ['unreachable', 'not_reachable'],
  ];
  for (const [alias, status] of variants) map.set(normaliseHeader(alias), status);
  return map;
})();

/**
 * Values that mean "nothing here" in an optional field, normalised. A sheet's "N/A" in
 * the email column is an absent email, not an invalid one.
 */
export const NULL_TOKENS: ReadonlySet<string> = new Set([
  '',
  'na',
  'n a',
  'nil',
  'none',
  'null',
  'not available',
]);

/** "Assigned to" values that mean "leave this one unassigned", normalised. */
export const UNASSIGNED_TOKENS: ReadonlySet<string> = new Set([
  'unassigned',
  'none',
  'nobody',
  'not assigned',
  'no one',
]);

/* -------------------------------------------------------------------------- */
/* Request schemas                                                             */
/* -------------------------------------------------------------------------- */

/** Multipart fields arrive as strings; an empty one means "not chosen". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const COLUMN_MAP_VALUES = [...LEAD_IMPORT_FIELDS, 'ignore'] as const;
export type ColumnMapValue = (typeof COLUMN_MAP_VALUES)[number];

const columnMapShape = z.record(
  z.string().regex(/^\d{1,2}$/),
  z.enum(COLUMN_MAP_VALUES),
);

/**
 * The preview's multipart fields (the file itself is handled by the upload middleware).
 *
 * `defaultAssignedTo` omitted, empty or `unassigned` all mean "leave rows without an
 * assignee unassigned" — always an explicit null downstream, never "absent", because an
 * absent assignee makes `createLead` give the lead to whoever is importing.
 */
export const leadImportPreviewSchema = z.object({
  defaultAssignedTo: z
    .string()
    .optional()
    .transform((value, context) => {
      const trimmed = value?.trim() ?? '';
      if (trimmed === '' || trimmed.toLowerCase() === 'unassigned') return null;
      const id = /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : NaN;
      if (!Number.isSafeInteger(id) || id <= 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose an active employee.' });
        return z.NEVER;
      }
      return id;
    }),
  defaultSource: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .toLowerCase()
      .max(40, 'Choose an active lead source.')
      .regex(/^[a-z0-9_]+$/, 'Choose an active lead source.')
      .optional(),
  ),
  defaultStatus: z.preprocess(
    blankToUndefined,
    z
      .enum(LEAD_STATUSES, { errorMap: () => ({ message: 'Choose a status.' }) })
      .default('new'),
  ),
  sheet: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
  /**
   * Manual column choices, as JSON: `{"<zero-based column>": "<field>" | "ignore"}`. They
   * replace the automatic match for those columns only.
   */
  columnMap: z
    .string()
    .max(4000, 'The column choices are too long.')
    .optional()
    .transform((value, context) => {
      if (value === undefined || value.trim() === '') return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'The column choices could not be read.' });
        return z.NEVER;
      }
      const result = columnMapShape.safeParse(parsed);
      if (!result.success) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'The column choices could not be read.' });
        return z.NEVER;
      }

      // Two columns read into one field would make a row's value depend on column order.
      const seen = new Map<string, string>();
      for (const [index, field] of Object.entries(result.data)) {
        if (field === 'ignore') continue;
        if (seen.has(field)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Two columns are set to ${LEAD_IMPORT_FIELD_LABELS[field]}. Choose one.`,
          });
          return z.NEVER;
        }
        seen.set(field, index);
      }

      const map = new Map<number, LeadImportField | null>();
      for (const [index, field] of Object.entries(result.data)) {
        map.set(Number(index), field === 'ignore' ? null : field);
      }
      return map;
    }),
  extraColumns: z.preprocess(blankToUndefined, z.enum(['ignore', 'notes']).default('ignore')),
  /** This user's earlier unconfirmed check of the same import, to be discarded. */
  replaces: z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional()),
});

export type LeadImportPreviewInput = z.infer<typeof leadImportPreviewSchema>;

/** The body is tiny, well under the 32 kb JSON limit. */
export const leadImportCommitSchema = z.object({
  batchSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(LEAD_IMPORT_LIMITS.batchMax)
    .default(LEAD_IMPORT_LIMITS.batchDefault),
});

export type LeadImportCommitInput = z.infer<typeof leadImportCommitSchema>;

export const leadImportListQuerySchema = paginationSchema.extend({
  state: z.enum(LEAD_IMPORT_STATES).optional(),
  /** Only the caller's own imports — the "you have an unfinished import" banner. */
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type LeadImportListQuery = z.infer<typeof leadImportListQuerySchema>;

/**
 * A filter that takes one value or several: `?outcome=error,duplicate_in_file` or the
 * parameter repeated. "Will be skipped" on the review screen is three outcomes at once.
 */
function listFilter<T extends readonly [string, ...string[]]>(values: T) {
  const allowed = new Set<string>(values);
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((raw, context): T[number][] | undefined => {
      if (raw === undefined) return undefined;
      const parts = (Array.isArray(raw) ? raw : [raw])
        .flatMap((item) => item.split(','))
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (parts.length === 0) return undefined;
      const unknown = parts.find((item) => !allowed.has(item));
      if (unknown !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Use one or more of: ${values.join(', ')}.`,
        });
        return z.NEVER;
      }
      return [...new Set(parts)] as T[number][];
    });
}

const rowFilterShape = {
  outcome: listFilter(LEAD_IMPORT_ROW_OUTCOMES),
  state: listFilter(LEAD_IMPORT_ROW_STATES),
};

/** One page of an import's rows, in sheet order. */
export const leadImportDetailQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(LEAD_IMPORT_LIMITS.rowsPageSizeMax)
    .default(LEAD_IMPORT_LIMITS.previewPageSize),
  ...rowFilterShape,
});

export type LeadImportDetailQuery = z.infer<typeof leadImportDetailQuerySchema>;

/** The rows-to-fix download: the same filters, every matching row (at most 2,000). */
export const leadImportRowsCsvQuerySchema = z.object(rowFilterShape);

export type LeadImportRowsCsvQuery = z.infer<typeof leadImportRowsCsvQuerySchema>;

export type LeadImportRowFilter = {
  outcome?: LeadImportRowOutcome[];
  state?: LeadImportRowState[];
};
