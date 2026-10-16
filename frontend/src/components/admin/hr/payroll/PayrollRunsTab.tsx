'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import {
  PAYROLL_RUN_STATUSES,
  PAYROLL_RUN_STATUS_LABELS,
  formatInr,
  formatPeriodRange,
  longCalendarDate,
  monthLabel,
  payrollApi,
  type PayrollPage,
  type PayrollRun,
  type PayrollRunStatus,
} from '@/lib/hrPayroll';
import { formatDate, todayIso } from '@/lib/telecalling';
import { EmptyPanel, Pager, TableSkeleton } from '../../telecalling/shared';
import { NewRunDialog } from './NewRunDialog';
import { PayrollRunDetail } from './PayrollRunDetail';
import { RunStatusTag, isAbort, readFailure } from './shared';

/**
 * Payroll runs: one per month, newest first, and the run that is open.
 *
 * The list and the open run share this component so that going back from a run returns
 * to the same filter and page, re-read — the run may have changed status while it was
 * open, and a list that still said "Processed" for a run just approved would be wrong.
 *
 * A DRAFT HAS NO FIGURES. The server stores zeros until a run is processed; showing
 * "₹0.00" against a month nobody has computed would read as "this month paid nothing",
 * so a draft's money columns say nothing at all.
 */

const PAGE_SIZE = 12;

type StatusFilter = PayrollRunStatus | 'all';

export function PayrollRunsTab({
  onUnauthorized,
  onRestricted,
  onOpenStructures,
}: {
  onUnauthorized: () => void;
  onRestricted: () => void;
  onOpenStructures: () => void;
}) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<PayrollPage<PayrollRun> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  /** The run that is open, with the row the list had for it and any message to carry in. */
  const [open, setOpen] = useState<{ id: number; run: PayrollRun | null; notice: string | null } | null>(
    null,
  );

  const abort = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  /** Set when a run closes, so the list's heading takes focus once it is back. */
  const focusListOnReturn = useRef(false);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(await payrollApi.listRuns({ status, page, pageSize: PAGE_SIZE }, controller.signal));
    } catch (caught) {
      if (isAbort(caught)) return;
      setError(readFailure(caught, { onUnauthorized, onRestricted }, 'Could not load the payroll runs.'));
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [status, page, onUnauthorized, onRestricted]);

  // The list is read while it is showing; an open run reads itself.
  useEffect(() => {
    if (open === null) void load();
  }, [load, open]);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (open === null && focusListOnReturn.current) {
      focusListOnReturn.current = false;
      headingRef.current?.focus();
    }
  }, [open]);

  // A page past the end — runs deleted since — goes back to the first page.
  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(1);
  }, [data, page]);

  const chooseStatus = (next: StatusFilter) => {
    setStatus(next);
    setPage(1);
    setNotice(null);
  };

  const openRun = (run: PayrollRun, message: string | null = null) => {
    setNotice(null);
    setOpen({ id: run.id, run, notice: message });
  };

  const closeRun = (message: string | null = null) => {
    focusListOnReturn.current = true;
    setNotice(message);
    setOpen(null);
  };

  /* ------------------------------------------------------------- open run */

  if (open) {
    return (
      <PayrollRunDetail
        key={open.id}
        runId={open.id}
        initialRun={open.run}
        initialNotice={open.notice}
        onBack={() => closeRun()}
        onDeleted={(run) => closeRun(`The ${monthLabel(run.period)} run was deleted.`)}
        onOpenStructures={onOpenStructures}
        onUnauthorized={onUnauthorized}
        onRestricted={onRestricted}
      />
    );
  }

  /* ----------------------------------------------------------------- list */

  const today = todayIso();
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="admin-toolbar">
        <h2 className="tc-section-title" style={{ margin: 0 }} ref={headingRef} tabIndex={-1}>
          Payroll runs
        </h2>

        <div className="admin-filters">
          <div className="field">
            <label className="field__label" htmlFor="hr-pay-run-status">
              Status
            </label>
            <select
              id="hr-pay-run-status"
              className="select"
              value={status}
              onChange={(event) => chooseStatus(event.target.value as StatusFilter)}
            >
              <option value="all">All runs</option>
              {PAYROLL_RUN_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PAYROLL_RUN_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <button type="button" className="btn btn--outline" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>

          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
            <Icon name="add" size={16} />
            New run
          </button>
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {loading && !data ? (
        <TableSkeleton rows={5} />
      ) : !data ? (
        <EmptyPanel
          title="Payroll runs not loaded"
          message="The list of payroll runs could not be loaded."
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : data.items.length === 0 ? (
        status === 'all' ? (
          <EmptyPanel
            title="No payroll runs yet"
            message="Create a run for a month, process it once the month is over, check the payslips and approve it to publish them to employees."
            actionLabel="New run"
            onAction={() => setCreating(true)}
          />
        ) : (
          <EmptyPanel
            title={`No ${PAYROLL_RUN_STATUS_LABELS[status].toLowerCase()} runs`}
            message="No payroll run is in that state. Show all runs to see the others."
            actionLabel="Show all runs"
            onAction={() => chooseStatus('all')}
          />
        )
      ) : (
        <LoadingOverlay busy={loading} label="Updating…">
          <DataTable
            rows={data.items}
            rowKey={(run) => run.id}
            minWidth="64rem"
            caption="Payroll runs, newest month first, with their totals"
            onRowDoubleClick={(run) => openRun(run)}
            rowTitle={() => 'Double-click to open the run'}
            columns={[
              {
                key: 'period',
                header: 'Period',
                render: (run) => (
                  <CellStack
                    primary={
                      <button type="button" className="hr-pay-link" onClick={() => openRun(run)}>
                        {monthLabel(run.period)}
                      </button>
                    }
                    secondary={formatPeriodRange(run.periodStart, run.periodEnd)}
                  />
                ),
              },
              {
                key: 'status',
                header: 'Status',
                width: '10rem',
                render: (run) => (
                  <CellStack
                    primary={<RunStatusTag status={run.status} />}
                    secondary={
                      run.status === 'draft'
                        ? today >= run.processableFrom
                          ? 'Ready to process'
                          : `From ${longCalendarDate(run.processableFrom)}`
                        : run.status === 'processed'
                          ? 'Waiting for approval'
                          : (run.approvedByName ?? undefined)
                    }
                  />
                ),
              },
              {
                key: 'employees',
                header: 'Employees',
                align: 'end',
                width: '7rem',
                nowrap: true,
                render: (run) =>
                  run.status === 'draft' ? <span className="tc-muted">—</span> : run.employeeCount.toLocaleString('en-IN'),
              },
              {
                key: 'gross',
                header: 'Gross',
                align: 'end',
                width: '9.5rem',
                nowrap: true,
                render: (run) => (run.status === 'draft' ? <span className="tc-muted">—</span> : formatInr(run.totalGross)),
              },
              {
                key: 'deductions',
                header: 'Deductions',
                align: 'end',
                width: '9rem',
                nowrap: true,
                render: (run) =>
                  run.status === 'draft' ? <span className="tc-muted">—</span> : formatInr(run.totalDeductions),
              },
              {
                key: 'net',
                header: 'Net pay',
                align: 'end',
                width: '9.5rem',
                nowrap: true,
                render: (run) =>
                  run.status === 'draft' ? (
                    <span className="tc-muted">—</span>
                  ) : (
                    <strong className="hr-pay-net">{formatInr(run.totalNet)}</strong>
                  ),
              },
              {
                key: 'dates',
                header: 'Dates',
                width: '11.5rem',
                nowrap: true,
                render: (run) => (
                  <div className="hr-pay-dates">
                    <span>
                      <span className="hr-pay-dates__label">Processed</span>{' '}
                      {run.processedAt ? formatDate(run.processedAt) : <span className="tc-muted">—</span>}
                    </span>
                    <span>
                      <span className="hr-pay-dates__label">Approved</span>{' '}
                      {run.approvedAt ? formatDate(run.approvedAt) : <span className="tc-muted">—</span>}
                    </span>
                  </div>
                ),
              },
            ]}
          />

          <Pager
            page={data.page}
            totalPages={totalPages}
            total={data.total}
            noun="run"
            busy={loading}
            onChange={setPage}
          />
        </LoadingOverlay>
      )}

      {creating ? (
        <NewRunDialog
          onClose={() => setCreating(false)}
          onUnauthorized={onUnauthorized}
          onCreated={(run) => {
            setCreating(false);
            openRun(
              run,
              `Draft run for ${monthLabel(run.period)} created. ${
                today >= run.processableFrom
                  ? 'The month is over, so it can be processed now.'
                  : `It can be processed from ${longCalendarDate(run.processableFrom)}.`
              }`,
            );
          }}
        />
      ) : null}
    </>
  );
}
