'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { ButtonSpinner, Loader, LoaderBlock, LoadingOverlay } from '@/components/admin/Loader';
import { FileField, FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import { ApiError, isApiConfigured } from '@/lib/api';
import {
  LEAD_IMPORT_EXTENSIONS,
  LEAD_IMPORT_FIELDS,
  LEAD_IMPORT_MAX_BYTES,
  LEAD_IMPORT_MAX_ROWS,
  LEAD_IMPORT_ROWS_PAGE_SIZE,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  formatCount,
  humanise,
  isLeadStatus,
  leadImportFormData,
  telecallingApi,
  type Employee,
  type LeadImport,
  type LeadImportColumn,
  type LeadImportField,
  type LeadImportPreview,
  type LeadImportRow,
  type LeadImportRowQuery,
  type LeadImportRowState,
  type LeadSourceRecord,
  type LeadStatus,
  type Paginated,
} from '@/lib/telecalling';
import { LeadLink } from './nav';
import { LeadStatusBadge, Pager, StatCard, StatGrid, Tag } from './shared';

/**
 * Importing leads from a spreadsheet: choose a file, check every row, import, see what
 * happened.
 *
 * Nothing is saved until the third step. Checking a file stages it on the server and
 * answers with what would happen to each row — imported, imported with a warning, or
 * skipped and why — so the manager decides with the whole picture in front of them. The
 * check is shown one server page at a time: a 2,000-row file is never sent to the browser
 * whole, and the filters (ready, warnings, will be skipped) are applied by the server.
 *
 * Importing runs in batches the server makes safe to repeat — each row is created at
 * most once whatever happens to a response — which is what lets this screen retry a
 * dropped connection on its own, and lets an import interrupted by a closed tab be
 * resumed from the lead list later rather than started over.
 *
 * Rendered inline by LeadsPanel, in place of the New lead card: a dialog is too narrow
 * for the row table, and the card matches how leads are created one at a time.
 */

type Step = 'choose' | 'review' | 'importing' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'choose', label: 'Choose a file' },
  { key: 'review', label: 'Check the rows' },
  { key: 'importing', label: 'Import' },
  { key: 'done', label: 'Done' },
];

/** The review table's filters. `skip` is every error and duplicate: the rows left out. */
type ReviewFilter = 'all' | 'ready' | 'warning' | 'skip';

/** The results table's filters, one per row state after the import. */
type ResultFilter = 'skipped' | 'failed' | 'not_imported' | 'created';

type Mapping = Record<number, LeadImportField | 'ignore'>;

type Pause = { message: string; tone: 'info' | 'error' };

const ACCEPT =
  '.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv';

/** Rows per commit request. The server stops each batch after ten seconds whatever this says. */
const COMMIT_BATCH_SIZE = 100;

/*
 * How long to keep trying on its own before pausing and handing the choice back.
 *
 * A dropped connection or a gateway timeout is retried every 2 s, five times. A 409
 * `import_busy` means another window holds the import's 60-second lock, so waiting out
 * that lock is twenty tries of 3 s. A 429 is the office-wide request limit, which resets
 * by the minute — four waits of 15 s.
 */
const NETWORK_RETRIES = 5;
const NETWORK_RETRY_MS = 2000;
const BUSY_RETRIES = 20;
const BUSY_RETRY_MS = 3000;
const RATE_RETRIES = 4;
const RATE_RETRY_MS = 15000;

const LEAVE_WARNING = 'Leaving pauses the import. You can resume it from Leads.';

const FIELD_LABELS: Record<LeadImportField, string> = {
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

const REQUIRED_FIELDS: ReadonlySet<LeadImportField> = new Set(['customerName', 'phone']);

function fieldLabel(key: string): string {
  return (FIELD_LABELS as Record<string, string>)[key] ?? humanise(key);
}

function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Bytes as KB or MB, as the file field shows them. */
function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Feedback before an upload, so a wrong file is caught without a round trip. The server
 * checks all of this again and more; it decides.
 */
function checkFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!LEAD_IMPORT_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'Choose an Excel file (.xlsx or .xls) or a CSV file.';
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > LEAD_IMPORT_MAX_BYTES) {
    return `This file is ${formatSize(file.size)}. The limit is 5 MB — split it into smaller files.`;
  }
  return null;
}

function toPage(rows: LeadImportRow[], page: LeadImportPreview['rowsPage']): Paginated<LeadImportRow> {
  return { items: rows, ...page };
}

function mappingOf(columns: LeadImportColumn[]): Mapping {
  const mapping: Mapping = {};
  for (const column of columns) mapping[column.index] = column.field ?? 'ignore';
  return mapping;
}

function reviewQuery(filter: ReviewFilter): LeadImportRowQuery {
  if (filter === 'ready') return { outcome: 'ready' };
  if (filter === 'warning') return { outcome: 'warning' };
  if (filter === 'skip') return { state: 'not_imported' };
  return {};
}

function OutcomeTag({ row }: { row: LeadImportRow }) {
  if (row.outcome === 'ready') return <Tag tone="good">Ready</Tag>;
  if (row.outcome === 'warning') return <Tag tone="warn">Warning</Tag>;
  if (row.outcome === 'error') return <Tag tone="bad">Error</Tag>;
  return <Tag tone="warn">Duplicate</Tag>;
}

function StateTag({ state }: { state: LeadImportRowState }) {
  if (state === 'created') return <Tag tone="good">Imported</Tag>;
  if (state === 'skipped') return <Tag tone="warn">Skipped</Tag>;
  if (state === 'failed') return <Tag tone="bad">Failed</Tag>;
  if (state === 'pending') return <Tag tone="progress">Waiting</Tag>;
  return <Tag>Not imported</Tag>;
}

/** The messages under a row's result, with the lead a duplicate collides with as a link. */
function RowMessages({ row }: { row: LeadImportRow }) {
  const items: { key: string; tone: 'error' | 'warn' | 'plain'; content: ReactNode }[] = [];

  for (const [field, message] of Object.entries(row.errors)) {
    items.push({ key: `e-${field}`, tone: 'error', content: `${fieldLabel(field)}: ${message}` });
  }
  for (const [field, message] of Object.entries(row.warnings)) {
    items.push({ key: `w-${field}`, tone: 'warn', content: `${fieldLabel(field)}: ${message}` });
  }

  const duplicate = row.duplicateOf;
  if (duplicate?.kind === 'row') {
    items.push({ key: 'dup', tone: 'warn', content: `Same number as row ${duplicate.sheetRow}` });
  } else if (duplicate?.kind === 'lead') {
    items.push({
      key: 'dup',
      tone: 'warn',
      content: (
        <>
          Already used by <LeadLink leadId={duplicate.id}>{duplicate.customerName}</LeadLink> (
          {duplicate.reference}), {duplicate.assignedToName ? `assigned to ${duplicate.assignedToName}` : 'unassigned'}
        </>
      ),
    });
  }

  if (row.resultMessage) items.push({ key: 'result', tone: 'plain', content: row.resultMessage });
  if (items.length === 0) return null;

  return (
    <ul className="tc-import__messages">
      {items.map((item) => (
        <li key={item.key} className={`tc-import__message tc-import__message--${item.tone}`}>
          {item.content}
        </li>
      ))}
    </ul>
  );
}

/** One page of rows, as checked (`review`) or as imported (`results`). */
function ImportRowsTable({ rows, mode }: { rows: LeadImportRow[]; mode: 'review' | 'results' }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(row) => row.sheetRow}
      rowTone={(row) =>
        mode === 'review'
          ? row.outcome === 'error'
            ? 'bad'
            : row.outcome === 'ready'
              ? undefined
              : 'warn'
          : row.state === 'failed'
            ? 'bad'
            : row.state === 'skipped'
              ? 'warn'
              : undefined
      }
      minWidth="65rem"
      caption={
        mode === 'review'
          ? 'Rows in the file and what will happen to each'
          : 'Rows in the file and what happened to each'
      }
      columns={[
        {
          key: 'row',
          header: 'Row',
          width: '4.5rem',
          nowrap: true,
          render: (row) => `Row ${row.sheetRow}`,
        },
        {
          key: 'customer',
          header: 'Customer',
          width: '13rem',
          render: (row) => {
            const name = row.values.customerName ?? '—';
            const phones = [row.values.phone, row.values.alternatePhone].filter(Boolean).join(' · ');
            return (
              <CellStack
                primary={row.leadId !== null ? <LeadLink leadId={row.leadId}>{name}</LeadLink> : name}
                secondary={phones || undefined}
              >
                {row.leadReference ? <span className="tc-muted tc-mono">{row.leadReference}</span> : null}
              </CellStack>
            );
          },
        },
        {
          // No width: email, city and interest take whatever space is left.
          key: 'details',
          header: 'Details',
          render: (row) => {
            const details = [row.values.email, row.values.city, row.values.productInterest].filter(Boolean);
            return details.length > 0 ? (
              <span className="tc-muted">{details.join(' · ')}</span>
            ) : (
              <span className="tc-muted">—</span>
            );
          },
        },
        {
          key: 'sourceStatus',
          header: 'Source and status',
          width: '10rem',
          render: (row) => (
            <CellStack
              primary={row.values.source ? humanise(row.values.source) : '—'}
              secondary={
                row.values.status === null ? undefined : isLeadStatus(row.values.status) ? (
                  <LeadStatusBadge status={row.values.status} />
                ) : (
                  row.values.status
                )
              }
            />
          ),
        },
        {
          key: 'assigned',
          header: 'Assigned to',
          width: '10rem',
          render: (row) => row.values.assignedToName ?? 'Unassigned',
        },
        {
          key: 'result',
          header: 'Result',
          width: '18rem',
          render: (row) => (
            <div className="tc-import__result">
              {mode === 'review' ? <OutcomeTag row={row} /> : <StateTag state={row.state} />}
              <RowMessages row={row} />
            </div>
          ),
        },
      ]}
    />
  );
}

type LeadImportPanelProps = {
  employees: Employee[];
  /** Active sources only: a retired one cannot be a default. */
  sources: LeadSourceRecord[];
  sourcesStatus: 'loading' | 'ready' | 'failed';
  /** An import to pick up where it stopped, from the lead list's "unfinished" notice. */
  resumeImportId: number | null;
  onUnauthorized: () => void;
  /** Closed without importing — or after cancelling. */
  onClose: () => void;
  /** Closed from the last step. The list reloads and says what was imported. */
  onFinished: (summary: LeadImport) => void;
  /** Whether batches are being imported right now, while the list must not close this. */
  onRunningChange: (running: boolean) => void;
};

export function LeadImportPanel({
  employees,
  sources,
  sourcesStatus,
  resumeImportId,
  onUnauthorized,
  onClose,
  onFinished,
  onRunningChange,
}: LeadImportPanelProps) {
  const [step, setStep] = useState<Step>('choose');

  /* Step 1: the file and the defaults for cells left empty. */
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [defaultAssignee, setDefaultAssignee] = useState('');
  const [chosenSource, setChosenSource] = useState('');
  const [defaultStatus, setDefaultStatus] = useState<LeadStatus>('new');
  const [keepExtraColumns, setKeepExtraColumns] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Step 2: what the check found. */
  const [importId, setImportId] = useState<number | null>(null);
  const [summary, setSummary] = useState<LeadImport | null>(null);
  const [columns, setColumns] = useState<LeadImportColumn[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  /** Column choices sent with the last successful check, kept across re-checks of one file. */
  const [overrides, setOverrides] = useState<Mapping>({});
  /** The sheet the last check read, sent again on a re-check of the same file. */
  const [sheet, setSheet] = useState<string | undefined>(undefined);
  /** The column choices on screen, which may be ahead of the last check. */
  const [mapping, setMapping] = useState<Mapping>({});
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [resultFilter, setResultFilter] = useState<ResultFilter>('skipped');
  const [rows, setRows] = useState<Paginated<LeadImportRow> | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [rowsPurged, setRowsPurged] = useState(false);

  /* Step 3: importing. */
  const [running, setRunning] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [paused, setPaused] = useState<Pause | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);

  /* Opening an import to resume. */
  const [opening, setOpening] = useState(resumeImportId !== null);
  const [openError, setOpenError] = useState<string | null>(null);

  const mountedRef = useRef(false);
  /** Bumped per import run, so a run superseded by a newer one stops at its next await. */
  const runRef = useRef(0);
  const pauseRequestedRef = useRef(false);
  /** A checked import not yet imported, cancelled if the panel goes away without it. */
  const draftRef = useRef<number | null>(null);
  const checkAbortRef = useRef<AbortController | null>(null);
  const rowsAbortRef = useRef<AbortController | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const stepTitleRef = useRef<HTMLHeadingElement | null>(null);
  const previousStepRef = useRef<Step | null>(null);

  /** 'manual' when it is offered, otherwise the first active source. */
  const defaultSource = useMemo(() => {
    if (chosenSource !== '' && sources.some((row) => row.slug === chosenSource)) return chosenSource;
    return sources.find((row) => row.slug === 'manual')?.slug ?? sources[0]?.slug ?? '';
  }, [chosenSource, sources]);

  /* ---------------------------------------------------------------- lifecycle */

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      checkAbortRef.current?.abort();
      rowsAbortRef.current?.abort();
      // A checked file nobody imported holds customers' details on the server until it
      // expires. Gone with the panel, it can never be imported from here, so it goes now.
      const draft = draftRef.current;
      draftRef.current = null;
      if (draft !== null) void telecallingApi.cancelLeadImport(draft).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    onRunningChange(running);
  }, [running, onRunningChange]);

  useEffect(() => () => onRunningChange(false), [onRunningChange]);

  // Closing or reloading the tab mid-import is allowed — the server keeps the import and
  // the lead list offers it again — but it should never happen by accident.
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = LEAVE_WARNING;
      return LEAVE_WARNING;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  // Focus: the panel's heading when it opens, then each step's heading as it arrives, so
  // a screen reader is told what the check found or how the import ended.
  useEffect(() => {
    const previous = previousStepRef.current;
    previousStepRef.current = step;
    if (previous === null) titleRef.current?.focus({ preventScroll: true });
    else if (previous !== step) stepTitleRef.current?.focus({ preventScroll: true });
  }, [step]);

  /* --------------------------------------------------------------------- rows */

  const loadRows = useCallback(
    async (id: number, query: LeadImportRowQuery) => {
      rowsAbortRef.current?.abort();
      const controller = new AbortController();
      rowsAbortRef.current = controller;

      setRowsLoading(true);
      setRowsError(null);

      try {
        const detail = await telecallingApi.leadImport(
          id,
          { pageSize: LEAD_IMPORT_ROWS_PAGE_SIZE, ...query },
          controller.signal,
        );
        setRows(toPage(detail.rows, detail.rowsPage));
        setSummary(detail.import);
        setRowsPurged(detail.rowsPurged === true);
        if (detail.columns.length > 0) setColumns(detail.columns);
      } catch (caught) {
        if (isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setRowsError(caught instanceof ApiError ? caught.message : 'Could not load these rows.');
      } finally {
        if (rowsAbortRef.current === controller) setRowsLoading(false);
      }
    },
    [onUnauthorized],
  );

  /** The last step, with the results table opened on the rows most worth a look. */
  const enterDone = useCallback(
    (final: LeadImport) => {
      draftRef.current = null;
      setSummary(final);
      setStep('done');

      const filter: ResultFilter =
        final.progress.skipped > 0
          ? 'skipped'
          : final.progress.failed > 0
            ? 'failed'
            : final.progress.notImported > 0
              ? 'not_imported'
              : 'created';
      setResultFilter(filter);
      void loadRows(final.id, { state: filter, page: 1 });
    },
    [loadRows],
  );

  /* ---------------------------------------------------------------- the check */

  const applyCheck = (result: LeadImportPreview, nextOverrides: Mapping) => {
    draftRef.current = result.import.id;
    setImportId(result.import.id);
    setSummary(result.import);
    setColumns(result.columns);
    setMapping(mappingOf(result.columns));
    setOverrides(nextOverrides);
    setSheet(result.import.sheetName ?? undefined);
    setNotices(result.notices);
    setRows(toPage(result.rows, result.rowsPage));
    setRowsPurged(false);
    setRowsError(null);
    setReviewFilter('all');
    setStep('review');
  };

  /**
   * Sends the file to be checked, with the defaults and any column choices.
   *
   * A re-check (other columns, another sheet, other defaults) replaces the previous
   * check of the same file on the server rather than leaving it behind.
   */
  const runCheck = async (options: { sheet?: string; overrides: Mapping }) => {
    if (!file) return;

    checkAbortRef.current?.abort();
    const controller = new AbortController();
    checkAbortRef.current = controller;

    setChecking(true);
    setError(null);
    setFieldErrors({});

    try {
      const result = await telecallingApi.previewLeadImport(
        leadImportFormData(file, {
          defaultAssignedTo: defaultAssignee === '' ? null : Number(defaultAssignee),
          defaultSource: defaultSource || undefined,
          defaultStatus,
          extraColumns: keepExtraColumns ? 'notes' : 'ignore',
          sheet: options.sheet ?? sheet,
          columnMap: options.overrides,
          replaces: draftRef.current ?? undefined,
        }),
        controller.signal,
      );
      if (!mountedRef.current) return;
      applyCheck(result, options.overrides);
    } catch (caught) {
      if (isAbort(caught)) return;
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors);
        const fileMessage = caught.fieldErrors.file;
        // A problem with the file itself belongs under the file, on the first step.
        if (fileMessage) {
          setFileError(fileMessage);
          setStep('choose');
        } else {
          setError(caught.message);
        }
      } else {
        setError('Could not check the file.');
      }
    } finally {
      if (checkAbortRef.current === controller) setChecking(false);
    }
  };

  const chooseFile = (next: File | null) => {
    setFile(next);
    setFileError(next ? checkFile(next) : null);
    setFieldErrors({});
    setError(null);
    // Column choices and the sheet belong to one file; another file starts from its own.
    setOverrides({});
    setSheet(undefined);
  };

  /** Column choices that differ from what the last check used. */
  const mappingChanges = useMemo(() => {
    const changes: Mapping = {};
    for (const column of columns) {
      const chosen = mapping[column.index] ?? 'ignore';
      if (chosen !== (column.field ?? 'ignore')) changes[column.index] = chosen;
    }
    return changes;
  }, [columns, mapping]);

  const mappingChanged = Object.keys(mappingChanges).length > 0;

  /** What is wrong with the column choices on screen, checked before asking the server. */
  const mappingProblems = useMemo(() => {
    const problems: string[] = [];
    const byField = new Map<LeadImportField, LeadImportColumn[]>();
    for (const column of columns) {
      const chosen = mapping[column.index] ?? 'ignore';
      if (chosen === 'ignore') continue;
      byField.set(chosen, [...(byField.get(chosen) ?? []), column]);
    }

    for (const [field, fieldColumns] of byField) {
      if (fieldColumns.length > 1) {
        problems.push(
          `Only one column can be read as ${FIELD_LABELS[field]}: columns ${fieldColumns
            .map((column) => column.letter)
            .join(' and ')} both are.`,
        );
      }
    }
    if (!byField.has('customerName') && !byField.has('firstName') && !byField.has('lastName')) {
      problems.push('No column is read as Customer name. Choose the column that holds the names.');
    }
    if (!byField.has('phone')) {
      problems.push('No column is read as Phone. Choose the column that holds the phone numbers.');
    }
    return problems;
  }, [columns, mapping]);

  const recheckWithMapping = () => {
    if (mappingProblems.length > 0) return;
    void runCheck({ overrides: { ...overrides, ...mappingChanges } });
  };

  const changeSheet = (sheet: string) => {
    // Another sheet has other columns, so earlier column choices do not carry over.
    void runCheck({ sheet, overrides: {} });
  };

  const changeReviewFilter = (filter: ReviewFilter) => {
    if (importId === null) return;
    setReviewFilter(filter);
    void loadRows(importId, { ...reviewQuery(filter), page: 1 });
  };

  const changeResultFilter = (filter: ResultFilter) => {
    if (importId === null) return;
    setResultFilter(filter);
    void loadRows(importId, { state: filter, page: 1 });
  };

  const turnRowsPage = (page: number) => {
    if (importId === null) return;
    void loadRows(
      importId,
      step === 'done' ? { state: resultFilter, page } : { ...reviewQuery(reviewFilter), page },
    );
  };

  /* ------------------------------------------------------------ the import run */

  const pause = (next: Pause) => {
    setRunning(false);
    setPausing(false);
    setRetryNotice(null);
    setPaused(next);
  };

  /** After a 409 `import_closed`: the import was stopped elsewhere, or its check expired. */
  const showClosed = async (id: number) => {
    try {
      const detail = await telecallingApi.leadImport(id, { page: 1, pageSize: LEAD_IMPORT_ROWS_PAGE_SIZE });
      if (mountedRef.current) enterDone(detail.import);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      if (mountedRef.current) {
        pause({ message: 'This import was stopped, or its check expired. Close and start again.', tone: 'error' });
      }
    }
  };

  /**
   * Imports batch after batch until the server says it is done.
   *
   * Every batch is safe to send twice, so a failure that might be passing — a dropped
   * connection, a gateway timeout, the import held by another window, the request limit —
   * is waited out and retried here, within the limits above. Anything else, or a limit
   * reached, pauses with the reason and leaves Resume and Stop to the manager.
   */
  const runImport = async (id: number) => {
    runRef.current += 1;
    const run = runRef.current;
    const live = () => mountedRef.current && runRef.current === run;

    draftRef.current = null;
    pauseRequestedRef.current = false;
    setPaused(null);
    setPausing(false);
    setRetryNotice(null);
    setConfirmStop(false);
    setRunning(true);
    setStep('importing');

    let networkFailures = 0;
    let busyWaits = 0;
    let rateWaits = 0;

    while (live()) {
      if (pauseRequestedRef.current) {
        pause({ message: 'Paused. Nothing is lost — resume when you are ready.', tone: 'info' });
        return;
      }

      try {
        const result = await telecallingApi.commitLeadImport(id, COMMIT_BATCH_SIZE);
        if (!live()) return;

        networkFailures = 0;
        busyWaits = 0;
        rateWaits = 0;
        setRetryNotice(null);
        setSummary(result.import);

        if (result.done) {
          setRunning(false);
          enterDone(result.import);
          return;
        }
      } catch (caught) {
        if (!live()) return;

        if (!(caught instanceof ApiError)) {
          pause({ message: 'The import stopped unexpectedly. Resume to carry on.', tone: 'error' });
          return;
        }
        if (caught.status === 401) {
          setRunning(false);
          onUnauthorized();
          return;
        }
        if (caught.status === 409 && caught.code === 'import_closed') {
          setRunning(false);
          await showClosed(id);
          return;
        }

        let delay: number | null = null;
        if ([0, 502, 503, 504].includes(caught.status) && networkFailures < NETWORK_RETRIES) {
          networkFailures += 1;
          delay = NETWORK_RETRY_MS;
          setRetryNotice(`The connection dropped. Trying again (${networkFailures} of ${NETWORK_RETRIES})…`);
        } else if (caught.status === 409 && caught.code === 'import_busy' && busyWaits < BUSY_RETRIES) {
          busyWaits += 1;
          delay = BUSY_RETRY_MS;
          setRetryNotice('This import is running in another window. Waiting for it to let go…');
        } else if (caught.status === 429 && rateWaits < RATE_RETRIES) {
          rateWaits += 1;
          delay = RATE_RETRY_MS;
          setRetryNotice('The server asked for a short break. Carrying on in 15 seconds…');
        }

        if (delay === null) {
          pause({ message: caught.message, tone: 'error' });
          return;
        }
        await sleep(delay);
      }
    }
  };

  const requestPause = () => {
    pauseRequestedRef.current = true;
    setPausing(true);
  };

  const startImport = () => {
    if (importId === null) return;
    void runImport(importId);
  };

  /** Stops a paused import for good. Leads already created stay. */
  const stopImport = async () => {
    if (importId === null) return;

    setStopping(true);
    setError(null);

    try {
      const final = await telecallingApi.cancelLeadImport(importId);
      if (!mountedRef.current) return;
      setConfirmStop(false);
      setPaused(null);
      enterDone(final);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not stop the import.');
    } finally {
      setStopping(false);
    }
  };

  /* ------------------------------------------------------------------ resume */

  const openResumed = useCallback(
    async (id: number, signal: AbortSignal) => {
      setOpening(true);
      setOpenError(null);

      try {
        const detail = await telecallingApi.leadImport(id, { page: 1, pageSize: LEAD_IMPORT_ROWS_PAGE_SIZE }, signal);
        setImportId(detail.import.id);
        setSummary(detail.import);
        setColumns(detail.columns);
        setMapping(mappingOf(detail.columns));
        setOpening(false);
        return detail;
      } catch (caught) {
        if (isAbort(caught)) return null;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return null;
        }
        setOpenError(
          caught instanceof ApiError && caught.status === 404
            ? 'That import could not be found. It may have been cleared.'
            : caught instanceof ApiError
              ? caught.message
              : 'Could not open the import.',
        );
        setOpening(false);
        return null;
      }
    },
    [onUnauthorized],
  );

  const [resumeAttempt, setResumeAttempt] = useState(0);

  useEffect(() => {
    if (resumeImportId === null) return;
    const controller = new AbortController();

    void openResumed(resumeImportId, controller.signal).then((detail) => {
      if (!detail || controller.signal.aborted) return;
      const state = detail.import.state;

      if (state === 'committing') {
        void runImport(detail.import.id);
      } else if (state === 'ready') {
        // Checked but never started. Without the file the columns cannot be re-read,
        // but the rows can still be looked through and imported.
        draftRef.current = detail.import.id;
        setRows(toPage(detail.rows, detail.rowsPage));
        setStep('review');
      } else {
        enterDone(detail.import);
      }
    });

    return () => controller.abort();
    // Runs once per resumed import (and per Retry); the run itself is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeImportId, resumeAttempt, openResumed]);

  /* ------------------------------------------------------------------ closing */

  /** Leaves without importing: a pending check is cancelled so it holds no data. */
  const cancelAndClose = () => {
    checkAbortRef.current?.abort();
    const draft = draftRef.current;
    draftRef.current = null;
    if (draft !== null) void telecallingApi.cancelLeadImport(draft).catch(() => undefined);
    onClose();
  };

  const finish = () => {
    if (summary) onFinished(summary);
    else onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // Never mid-import or mid-request: Escape is too easy to press by accident for that.
    if (step === 'importing' || checking || stopping) return;
    event.preventDefault();
    if (step === 'done') finish();
    else cancelAndClose();
  };

  /* ---------------------------------------------------------------- downloads */

  /**
   * The rows that were not imported, as a CSV with the file's own columns and a Problem
   * column — fix them, delete the Problem column, and import the file again.
   *
   * The server writes the file: the table holds one page of rows at a time, and gathering
   * every page to write it out here would fetch the whole import into the browser. At the
   * check that is the errors and duplicates; after an import, the rows refused or failed
   * while importing as well.
   *
   * A link carrying the session cookie, like the template. A new tab, so a refused request
   * — a session that ended, rows cleared after 90 days — shows its message there instead of
   * replacing this screen; a file that downloads leaves no tab behind.
   */
  const rowsToFixLink = (id: number) => (
    <a
      className="btn btn--outline btn--sm"
      href={telecallingApi.leadImportRowsCsvUrl(id)}
      target="_blank"
      rel="noopener"
    >
      <Icon name="download" size={15} />
      Download rows to fix (CSV)
    </a>
  );

  /* -------------------------------------------------------------------- view */

  const totals = summary?.totals;
  const progress = summary?.progress;
  const importable = totals ? totals.ready + totals.warnings : 0;
  const skippedAtCheck = totals ? totals.errors + totals.duplicatesInFile + totals.duplicatesExisting : 0;
  const processed = progress ? progress.created + progress.skipped + progress.failed : 0;
  const toProcess = progress ? processed + progress.pending : 0;
  const percent = toProcess > 0 ? Math.round((processed / toProcess) * 100) : 0;
  const rowsToFix = progress ? progress.skipped + progress.failed + progress.notImported : 0;
  const stepIndex = STEPS.findIndex((item) => item.key === step);

  const stepTitle = (text: string) => (
    <h4 ref={stepTitleRef} tabIndex={-1} className="tc-import__step-title">
      {text}
    </h4>
  );

  const rowsTable = (mode: 'review' | 'results') =>
    rowsPurged ? (
      <p className="tc-muted">The row details of this import have been cleared, as they are after 90 days.</p>
    ) : rows && rows.total > 0 ? (
      <>
        <LoadingOverlay busy={rowsLoading}>
          <ImportRowsTable rows={rows.items} mode={mode} />
        </LoadingOverlay>
        <Pager
          page={rows.page}
          totalPages={rows.totalPages}
          total={rows.total}
          noun="row"
          busy={rowsLoading}
          onChange={turnRowsPage}
        />
      </>
    ) : rowsLoading ? (
      <LoaderBlock label="Loading the rows…" minHeight="8rem" />
    ) : (
      <p className="tc-muted">No rows here.</p>
    );

  let content: ReactNode;

  if (opening) {
    content = <LoaderBlock label="Opening the import…" />;
  } else if (openError) {
    content = (
      <div className="tc-import__section">
        <FormAlert variant="error">{openError}</FormAlert>
        <div className="tc-import__actions">
          <button type="button" className="btn btn--outline btn--sm" onClick={() => setResumeAttempt((value) => value + 1)}>
            <Icon name="refresh" size={15} />
            Try again
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  } else if (step === 'choose') {
    content = (
      <div className="tc-import__section">
        <div className="tc-import__legend">
          <p>
            Each row needs a <strong>Customer name</strong> <Tag tone="warn">Required</Tag> and a{' '}
            <strong>Phone</strong> <Tag tone="warn">Required</Tag>. Optional: Alternate phone, Email, City, Address,
            Source, Product interest, Status, Assigned to (an employee code, email or exact name) and Notes.
          </p>
          <p>
            Column headings are matched without regard to case or punctuation — “MOBILE NO.” or “Contact number” is
            read as Phone. Each number can belong to only one active lead, so a number already in use is skipped.
          </p>
        </div>

        <FileField
          label="Spreadsheet"
          name="lead-import-file"
          file={file}
          accept={ACCEPT}
          onChange={chooseFile}
          hint={`Excel (.xlsx or .xls) or CSV, up to 5 MB and ${formatCount(LEAD_IMPORT_MAX_ROWS)} rows.`}
          error={fileError ?? undefined}
          disabled={checking}
          buttonLabel="Choose a file"
          required
        />

        <div className="tc-form__grid">
          <div className="field">
            <label className="field__label" htmlFor="tc-import-assignee">
              Rows with no “Assigned to” go to
            </label>
            <select
              id="tc-import-assignee"
              className="select"
              value={defaultAssignee}
              disabled={checking}
              onChange={(event) => setDefaultAssignee(event.target.value)}
            >
              <option value="">Leave them unassigned</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
            {fieldErrors.defaultAssignedTo ? (
              <p className="field__error">{fieldErrors.defaultAssignedTo}</p>
            ) : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-import-source">
              Source when a row has none
            </label>
            <select
              id="tc-import-source"
              className="select"
              value={defaultSource}
              disabled={checking || sources.length === 0}
              onChange={(event) => setChosenSource(event.target.value)}
            >
              {sources.length === 0 ? <option value="">—</option> : null}
              {sources.map((row) => (
                <option key={row.slug} value={row.slug}>
                  {row.label}
                </option>
              ))}
            </select>
            {fieldErrors.defaultSource ? (
              <p className="field__error">{fieldErrors.defaultSource}</p>
            ) : sourcesStatus === 'loading' ? (
              <Loader inline size="sm" label="Loading sources…" />
            ) : sources.length === 0 ? (
              <p className="field__hint">Rows with no source will be saved as Manual entry.</p>
            ) : (
              <p className="field__hint">A source the sheet names that is not set up also falls back to this.</p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="tc-import-status">
              Status when a row has none
            </label>
            <select
              id="tc-import-status"
              className="select"
              value={defaultStatus}
              disabled={checking}
              onChange={(event) => setDefaultStatus(event.target.value as LeadStatus)}
            >
              {LEAD_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {LEAD_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
            {fieldErrors.defaultStatus ? <p className="field__error">{fieldErrors.defaultStatus}</p> : null}
          </div>
        </div>

        <div className="field">
          <label className="tc-import__check">
            <input
              type="checkbox"
              checked={keepExtraColumns}
              disabled={checking}
              onChange={(event) => setKeepExtraColumns(event.target.checked)}
            />
            Keep other columns in the lead’s notes
          </label>
          <p className="field__hint">
            Columns that match no lead field are added to the notes as “Heading: value” lines. Otherwise they are
            left out.
          </p>
        </div>

        <div className="tc-import__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void runCheck({ overrides })}
            disabled={!file || fileError !== null || checking}
            aria-busy={checking || undefined}
          >
            {checking ? (
              <>
                <ButtonSpinner />
                Checking…
              </>
            ) : (
              'Check file'
            )}
          </button>

          {isApiConfigured() ? (
            /*
             * A plain link that carries the session cookie, like a recording: the template
             * is a file for the browser to save, not data for this screen. A new tab for
             * the reason the rows-to-fix link gives.
             */
            <a
              className="btn btn--ghost btn--sm"
              href={telecallingApi.leadImportTemplateUrl()}
              target="_blank"
              rel="noopener"
            >
              <Icon name="download" size={15} />
              Download the template
            </a>
          ) : null}

          <button type="button" className="btn btn--ghost btn--sm" onClick={cancelAndClose} disabled={checking}>
            Cancel
          </button>
        </div>
        <p className="tc-muted">Nothing is saved until you press Import on the next step.</p>
      </div>
    );
  } else if (step === 'review' && summary && totals) {
    const defaultOwner = summary.defaults.assignedToName ?? 'nobody (left unassigned)';
    const defaultSourceLabel =
      sources.find((row) => row.slug === summary.defaults.source)?.label ?? humanise(summary.defaults.source);
    const segments: { key: ReviewFilter; label: string; count: number }[] = [
      { key: 'all', label: 'All', count: totals.rows },
      { key: 'ready', label: 'Ready', count: totals.ready },
      { key: 'warning', label: 'Warnings', count: totals.warnings },
      { key: 'skip', label: 'Will be skipped', count: skippedAtCheck },
    ];

    content = (
      <LoadingOverlay busy={checking} label="Checking the file again…">
        <div className="tc-import__section">
          {stepTitle(`What will happen to the ${formatCount(totals.rows)} rows in ${summary.fileName}`)}
          <p className="tc-muted">
            {summary.sheetName ? `Sheet “${summary.sheetName}”, headings` : 'Headings'} on row {summary.headerRow}.
            Rows with no owner go to {defaultOwner}; with no source, {defaultSourceLabel}; with no status,{' '}
            {LEAD_STATUS_LABELS[summary.defaults.status] ?? humanise(summary.defaults.status)}.
          </p>

          <StatGrid>
            <StatCard value={formatCount(totals.rows)} label="Rows in the file" />
            <StatCard tone="good" value={formatCount(totals.ready)} label="Ready" hint="Will be imported" />
            <StatCard tone="warn" value={formatCount(totals.warnings)} label="Warnings" hint="Will be imported" />
            <StatCard tone="bad" value={formatCount(totals.errors)} label="Errors" hint="Will be skipped" />
            <StatCard
              tone="warn"
              value={formatCount(totals.duplicatesInFile + totals.duplicatesExisting)}
              label="Duplicates"
              hint={`${formatCount(totals.duplicatesInFile)} in this file · ${formatCount(totals.duplicatesExisting)} already saved`}
            />
          </StatGrid>

          {notices.length > 0 ? (
            <FormAlert variant="info">
              <ul className="tc-import__notices">
                {notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </FormAlert>
          ) : null}

          {error ? <FormAlert variant="error">{error}</FormAlert> : null}

          <fieldset className="tc-import__mapping-block" disabled={!file || checking}>
            <legend className="tc-import__subtitle">How the columns are read</legend>
            {!file ? (
              <p className="tc-muted">Choose the file again to change how its columns are read.</p>
            ) : null}

            {summary.sheetNames.length > 1 ? (
              <div className="field tc-import__sheet">
                <label className="field__label" htmlFor="tc-import-sheet">
                  Sheet
                </label>
                <select
                  id="tc-import-sheet"
                  className="select select--sm"
                  value={summary.sheetName ?? ''}
                  onChange={(event) => changeSheet(event.target.value)}
                >
                  {summary.sheetNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="tc-import__mapping">
              {columns.map((column) => {
                const chosen = mapping[column.index] ?? 'ignore';
                return (
                  <div key={column.index} className="field tc-import__column">
                    <label className="field__label" htmlFor={`tc-import-column-${column.index}`}>
                      <span className="tc-mono">{column.letter}</span> {column.header || '(no heading)'}
                    </label>
                    <select
                      id={`tc-import-column-${column.index}`}
                      className="select select--sm"
                      value={chosen}
                      onChange={(event) =>
                        setMapping((current) => ({
                          ...current,
                          [column.index]: event.target.value as LeadImportField | 'ignore',
                        }))
                      }
                    >
                      <option value="ignore">Leave this column out</option>
                      {LEAD_IMPORT_FIELDS.map((field) => (
                        <option key={field} value={field}>
                          {FIELD_LABELS[field]}
                        </option>
                      ))}
                    </select>
                    <span className="tc-import__column-meta">
                      {chosen !== 'ignore' && REQUIRED_FIELDS.has(chosen) ? <Tag tone="warn">Required</Tag> : null}
                      <span className="tc-muted">
                        {chosen !== (column.field ?? 'ignore')
                          ? 'Changed — check again to use it'
                          : column.matchedBy === 'alias'
                            ? 'Matched from its heading'
                            : column.matchedBy === 'manual'
                              ? 'Chosen by you'
                              : 'Not matched'}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>

            {mappingProblems.map((problem) => (
              <p key={problem} className="field__error">
                {problem}
              </p>
            ))}
            {fieldErrors.columnMap ? <p className="field__error">{fieldErrors.columnMap}</p> : null}

            {mappingChanged ? (
              <div className="tc-import__actions">
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  onClick={recheckWithMapping}
                  disabled={mappingProblems.length > 0 || checking}
                >
                  Check again with these columns
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setMapping(mappingOf(columns))}
                  disabled={checking}
                >
                  Undo changes
                </button>
              </div>
            ) : null}
          </fieldset>

          <div className="tc-import__table-head">
            <h5 className="tc-import__subtitle">Rows</h5>
            <div className="tc-segmented" role="group" aria-label="Show rows">
              {segments.map((segment) => (
                <button
                  key={segment.key}
                  type="button"
                  className="tc-segmented__button"
                  aria-pressed={reviewFilter === segment.key}
                  onClick={() => changeReviewFilter(segment.key)}
                >
                  {segment.label} ({formatCount(segment.count)})
                </button>
              ))}
            </div>
          </div>

          {rowsError ? <FormAlert variant="error">{rowsError}</FormAlert> : null}
          {rowsTable('review')}

          <div className="tc-import__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={startImport}
              disabled={importable === 0 || checking || mappingChanged}
            >
              <Icon name="upload" size={16} />
              Import {formatCount(importable)} lead{importable === 1 ? '' : 's'}
            </button>

            {skippedAtCheck > 0 && importId !== null ? rowsToFixLink(importId) : null}

            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setError(null);
                setStep('choose');
              }}
              disabled={checking}
            >
              <Icon name="arrowLeft" size={15} />
              Change file or defaults
            </button>

            <button type="button" className="btn btn--ghost btn--sm" onClick={cancelAndClose} disabled={checking}>
              Cancel
            </button>
          </div>
          <p className="tc-muted">
            {mappingChanged
              ? 'Check again first, so the import uses the columns as you have set them.'
              : importable === 0
                ? 'No row can be imported as it stands. Download the rows to fix, correct them and check the file again.'
                : 'Rows with errors or duplicates will be skipped. Nothing is saved until you press Import.'}
          </p>
        </div>
      </LoadingOverlay>
    );
  } else if (step === 'importing' && summary && progress) {
    content = (
      <div className="tc-import__section">
        {stepTitle(running ? `Importing from ${summary.fileName}` : `The import of ${summary.fileName} is paused`)}

        <div
          className="tc-import__progress"
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={toProcess}
          aria-valuenow={processed}
          aria-valuetext={`${formatCount(processed)} of ${formatCount(toProcess)} rows done`}
        >
          <span className="tc-import__progress-bar" style={{ width: `${percent}%` }} />
        </div>

        <p className="tc-import__progress-text" aria-live="polite">
          {formatCount(processed)} of {formatCount(toProcess)} rows done ({percent}%)
          {running ? '…' : '.'}
        </p>
        <p className="tc-muted">
          {formatCount(progress.created)} imported · {formatCount(progress.skipped)} skipped ·{' '}
          {formatCount(progress.failed)} could not be saved
        </p>

        {retryNotice && running ? <Loader inline size="sm" label={retryNotice} /> : null}
        {paused ? <FormAlert variant={paused.tone}>{paused.message}</FormAlert> : null}
        {error ? <FormAlert variant="error">{error}</FormAlert> : null}

        <div className="tc-import__actions">
          {running ? (
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={requestPause}
              disabled={pausing}
              aria-busy={pausing || undefined}
            >
              {pausing ? <ButtonSpinner /> : null}
              {pausing ? 'Pausing after this batch…' : 'Pause'}
            </button>
          ) : confirmStop ? (
            <>
              <span>Stop for good? Leads already imported are kept.</span>
              <button
                type="button"
                className="btn btn--outline btn--sm"
                onClick={() => void stopImport()}
                disabled={stopping}
                aria-busy={stopping || undefined}
              >
                {stopping ? <ButtonSpinner /> : null}
                Stop import
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setConfirmStop(false)}
                disabled={stopping}
              >
                Keep it
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn--primary btn--sm" onClick={startImport}>
                Resume import
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmStop(true)}>
                Stop import
              </button>
            </>
          )}
        </div>

        <p className="tc-muted">
          {running
            ? 'You can keep working in another tab. Leaving this page pauses the import; you can resume it from Leads.'
            : 'Paused imports can be resumed later from Leads.'}
        </p>
      </div>
    );
  } else if (step === 'done' && summary && progress) {
    const stopped = summary.state !== 'completed';
    const segments: { key: ResultFilter; label: string; count: number }[] = [
      { key: 'skipped', label: 'Skipped', count: progress.skipped },
      { key: 'failed', label: 'Could not be saved', count: progress.failed },
      { key: 'not_imported', label: 'Not imported', count: progress.notImported },
      { key: 'created', label: 'Imported', count: progress.created },
    ];

    content = (
      <div className="tc-import__section">
        {stepTitle(
          summary.state === 'expired'
            ? `The check of ${summary.fileName} expired`
            : stopped
              ? `The import of ${summary.fileName} was stopped`
              : `Imported from ${summary.fileName}`,
        )}

        {summary.state === 'expired' ? (
          <FormAlert variant="info">
            A checked file can be imported for a day. Nothing was imported — check the file again to start over.
          </FormAlert>
        ) : stopped ? (
          <FormAlert variant="info">Leads imported before it was stopped are kept.</FormAlert>
        ) : null}

        <StatGrid>
          <StatCard tone="good" value={formatCount(progress.created)} label="Imported" />
          <StatCard
            tone="warn"
            value={formatCount(progress.skipped)}
            label="Skipped"
            hint="Refused when imported, e.g. the number was taken meanwhile"
          />
          <StatCard tone="bad" value={formatCount(progress.failed)} label="Could not be saved" />
          <StatCard
            value={formatCount(progress.notImported)}
            label="Not imported"
            hint="Errors and duplicates found by the check"
          />
        </StatGrid>

        <div className="tc-import__table-head">
          <h5 className="tc-import__subtitle">Rows</h5>
          <div className="tc-segmented" role="group" aria-label="Show rows">
            {segments
              .filter((segment) => segment.count > 0 || segment.key === resultFilter)
              .map((segment) => (
                <button
                  key={segment.key}
                  type="button"
                  className="tc-segmented__button"
                  aria-pressed={resultFilter === segment.key}
                  onClick={() => changeResultFilter(segment.key)}
                >
                  {segment.label} ({formatCount(segment.count)})
                </button>
              ))}
          </div>
        </div>

        {rowsError ? <FormAlert variant="error">{rowsError}</FormAlert> : null}
        {rowsTable('results')}

        <div className="tc-import__actions">
          <button type="button" className="btn btn--primary" onClick={finish}>
            Close
          </button>
          {rowsToFix > 0 && !rowsPurged && importId !== null ? rowsToFixLink(importId) : null}
        </div>
      </div>
    );
  } else {
    content = <LoaderBlock label="Loading the import…" />;
  }

  return (
    <section className="tc-card tc-import" aria-labelledby="tc-import-title" onKeyDown={onKeyDown}>
      <div className="tc-import__head">
        <h3 id="tc-import-title" ref={titleRef} tabIndex={-1} className="tc-import__title">
          Import leads
        </h3>
        <ol className="tc-import__steps" aria-label="Steps">
          {STEPS.map((item, index) => (
            <li
              key={item.key}
              className={`tc-import__step${index < stepIndex ? ' tc-import__step--done' : ''}`}
              aria-current={item.key === step ? 'step' : undefined}
            >
              <span className="tc-import__step-number" aria-hidden="true">
                {index < stepIndex ? <Icon name="check" size={12} /> : index + 1}
              </span>
              {item.label}
            </li>
          ))}
        </ol>
      </div>

      {content}
    </section>
  );
}
