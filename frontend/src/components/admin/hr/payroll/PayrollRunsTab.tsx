'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CellStack, DataTable } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import {
  PAYROLL_RUN_STATUSES,
  PAYROLL_RUN_STATUS_LABELS,
  dayMonth,
  describeCycle,
  formatInr,
  formatPeriodRange,
  monthLabel,
  payrollApi,
  runStage,
  shortCalendarDate,
  type PayrollPage,
  type PayrollRun,
  type PayrollRunStatus,
} from '@/lib/hrPayroll';
import { formatDate, todayIso } from '@/lib/telecalling';
import { EmptyPanel, Pager, TableSkeleton } from '../../telecalling/shared';
import { HowPayrollWorks } from './HowPayrollWorks';
import { NewRunDialog } from './NewRunDialog';
import { PayCycleDialog } from './PayCycleDialog';
import { PayrollRunDetail } from './PayrollRunDetail';
import type { StructuresTarget } from './SalaryStructuresTab';
import { RunStatusTag, isAbort, readFailure } from './shared';

/**
 * Pay periods: one per month, newest first, the pay cycle they follow, and the period
 * that is open. (The API calls a pay period a payroll "run".)
 *
 * The list and the open period share this component so that going back from a period
 * returns to the same filter and page, re-read — the period may have moved on while it
 * was open, and a list that still said "Calculated so far" for one just approved would
 * be wrong.
 *
 * NOT CALCULATED MEANS NO FIGURES. The server stores zeros until a period is calculated;
 * showing "₹0.00" against a period nobody has worked out would read as "this month paid
 * nothing", so a draft's money columns say nothing at all. Figures calculated while the
 * period is still running are marked "so far" — they grow until the period ends.
 *
 * THE PAY CYCLE (the HR setting `payrollCycleStartDay`) is read here because three things
 * on this screen use it: the line that states it, the "How payroll works" card, and the
 * new-period dialog's default and preview. It is allowed to fail quietly — the list still
 * works, and the server applies the cycle itself when a period is opened.
 */

const PAGE_SIZE = 12;

type StatusFilter = PayrollRunStatus | 'all';

/** The quieter line under a period's status: what happens next, in a few words. */
function statusDetail(run: PayrollRun, today: string): string | undefined {
  switch (runStage(run)) {
    case 'not_calculated':
      return today >= run.processableFrom
        ? 'Can be calculated now'
        : `Can be calculated from ${shortCalendarDate(run.processableFrom)}`;
    case 'so_far': {
      const through = run.calculatedThrough ? `To ${dayMonth(run.calculatedThrough)} · ` : '';
      return today >= run.approvableFrom
        ? `${through}period ended, recalculate to approve`
        : `${through}runs until ${dayMonth(run.periodEnd)}`;
    }
    case 'ready':
      return 'Check the payslips, then approve';
    case 'nobody': {
      if (run.exclusions.length === 0) return 'Nobody employed in it';
      /*
       * By the reason, because the advice differs: "set up salaries" is wrong for people
       * whose salary is set up but starts after the period — the usual cause is a period
       * opened too early, and the fix is the next one.
       */
      if (run.exclusions.every((entry) => entry.reason === 'structure_starts_later')) {
        return 'Salaries start after this period';
      }
      if (run.exclusions.every((entry) => entry.reason === 'no_structure')) {
        return 'Set up salaries, then recalculate';
      }
      return 'Open it to see who was left out';
    }
    case 'approved':
      return run.approvedByName ?? undefined;
  }
}

export function PayrollRunsTab({
  onUnauthorized,
  onRestricted,
  onOpenStructures,
}: {
  onUnauthorized: () => void;
  onRestricted: () => void;
  /** Opens Salary structures — as it was left, or on a filter or one employee. */
  onOpenStructures: (target?: StructuresTarget) => void;
}) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<PayrollPage<PayrollRun> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** The pay cycle's start day; null while loading or when it could not be read. */
  const [cycle, setCycle] = useState<number | null>(null);
  const [cycleFailed, setCycleFailed] = useState(false);
  const [changingCycle, setChangingCycle] = useState(false);

  const [creating, setCreating] = useState(false);
  /** The period that is open, with the row the list had for it and any message to carry in. */
  const [open, setOpen] = useState<{ id: number; run: PayrollRun | null; notice: string | null } | null>(
    null,
  );

  const abort = useRef<AbortController | null>(null);
  const cycleAbort = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  /** Set when a period closes, so the list's heading takes focus once it is back. */
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
      setError(readFailure(caught, { onUnauthorized, onRestricted }, 'Could not load the pay periods.'));
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }, [status, page, onUnauthorized, onRestricted]);

  const loadCycle = useCallback(async () => {
    cycleAbort.current?.abort();
    const controller = new AbortController();
    cycleAbort.current = controller;

    setCycleFailed(false);
    try {
      setCycle(await payrollApi.cycleStartDay(controller.signal));
    } catch (caught) {
      if (isAbort(caught)) return;
      // A failed read of the cycle is said on its own line, not as a banner over the list.
      if (readFailure(caught, { onUnauthorized, onRestricted }, '') !== null) setCycleFailed(true);
    }
  }, [onUnauthorized, onRestricted]);

  // The list is read while it is showing; an open period reads itself.
  useEffect(() => {
    if (open === null) void load();
  }, [load, open]);

  useEffect(() => {
    void loadCycle();
  }, [loadCycle]);

  useEffect(
    () => () => {
      abort.current?.abort();
      cycleAbort.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (open === null && focusListOnReturn.current) {
      focusListOnReturn.current = false;
      headingRef.current?.focus();
    }
  }, [open]);

  // A page past the end — periods deleted since — goes back to the first page.
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

  const refresh = () => {
    setNotice(null);
    void load();
    void loadCycle();
  };

  /* ---------------------------------------------------------- open period */

  if (open) {
    return (
      <PayrollRunDetail
        key={open.id}
        runId={open.id}
        initialRun={open.run}
        initialNotice={open.notice}
        onBack={() => closeRun()}
        onDeleted={(run) => closeRun(`The ${monthLabel(run.period)} pay period was deleted.`)}
        onOpenStructures={onOpenStructures}
        onUnauthorized={onUnauthorized}
        onRestricted={onRestricted}
      />
    );
  }

  /* ----------------------------------------------------------------- list */

  const today = todayIso();
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  /** A money cell: nothing before a calculation, "so far" under a provisional figure. */
  const money = (run: PayrollRun, amount: number, strong = false): ReactNode => {
    if (run.status === 'draft') return <span className="tc-muted">—</span>;
    const figure = strong ? <strong className="hr-pay-net">{formatInr(amount)}</strong> : formatInr(amount);
    return runStage(run) === 'so_far' ? <CellStack primary={figure} secondary="so far" /> : figure;
  };

  return (
    <>
      <div className="admin-toolbar">
        <div className="hr-pay-heading">
          <h2 className="tc-section-title" style={{ margin: 0 }} ref={headingRef} tabIndex={-1}>
            Pay periods
          </h2>
          <HowPayrollWorks startDay={cycle} onOpenStructures={() => onOpenStructures()} />
        </div>

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
              <option value="all">All pay periods</option>
              {PAYROLL_RUN_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PAYROLL_RUN_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <button type="button" className="btn btn--outline" onClick={refresh} disabled={loading}>
            <Icon name="refresh" size={16} />
            Refresh
          </button>

          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
            <Icon name="add" size={16} />
            New pay period
          </button>
        </div>
      </div>

      {/* The pay cycle every period follows, and the way to change it. */}
      <p className="hr-pay-cycle">
        <Icon name="calendar" size={16} />
        {cycle !== null ? (
          <>
            <span>{describeCycle(cycle)}.</span>
            <button type="button" className="tc-text-button" onClick={() => setChangingCycle(true)}>
              Change<span className="sr-only"> the pay cycle</span>
            </button>
          </>
        ) : cycleFailed ? (
          <>
            <span>The pay cycle could not be loaded.</span>
            <button type="button" className="tc-text-button" onClick={() => void loadCycle()}>
              Try again
            </button>
          </>
        ) : (
          <span className="tc-muted">Loading the pay cycle…</span>
        )}
      </p>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {loading && !data ? (
        <TableSkeleton rows={5} />
      ) : !data ? (
        <EmptyPanel
          title="Pay periods not loaded"
          message="The list of pay periods could not be loaded."
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : data.items.length === 0 ? (
        status === 'all' ? (
          <EmptyPanel
            title="No pay periods yet"
            message="Open the pay period running now, calculate payslips any time to see the figures so far, and approve once it has ended to publish them to employees."
            actionLabel="New pay period"
            onAction={() => setCreating(true)}
          />
        ) : (
          <EmptyPanel
            title="No pay periods in that state"
            message={`No pay period is “${PAYROLL_RUN_STATUS_LABELS[status]}”. Show all pay periods to see the others.`}
            actionLabel="Show all pay periods"
            onAction={() => chooseStatus('all')}
          />
        )
      ) : (
        <LoadingOverlay busy={loading} label="Updating…">
          <DataTable
            rows={data.items}
            rowKey={(run) => run.id}
            minWidth="66rem"
            caption="Pay periods, newest first, with their totals"
            onRowDoubleClick={(run) => openRun(run)}
            rowTitle={() => 'Double-click to open the pay period'}
            columns={[
              {
                key: 'period',
                header: 'Pay period',
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
                width: '12rem',
                render: (run) => (
                  <CellStack primary={<RunStatusTag run={run} compact />} secondary={statusDetail(run, today)} />
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
                render: (run) => money(run, run.totalGross),
              },
              {
                key: 'deductions',
                header: 'Deductions',
                align: 'end',
                width: '9rem',
                nowrap: true,
                render: (run) => money(run, run.totalDeductions),
              },
              {
                key: 'net',
                header: 'Net pay',
                align: 'end',
                width: '9.5rem',
                nowrap: true,
                render: (run) => money(run, run.totalNet, true),
              },
              {
                key: 'dates',
                header: 'Dates',
                width: '11.5rem',
                nowrap: true,
                render: (run) => (
                  <div className="hr-pay-dates">
                    <span>
                      <span className="hr-pay-dates__label">Calculated</span>{' '}
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
            noun="pay period"
            busy={loading}
            onChange={setPage}
          />
        </LoadingOverlay>
      )}

      {creating ? (
        <NewRunDialog
          startDay={cycle}
          onClose={() => setCreating(false)}
          onUnauthorized={onUnauthorized}
          onCreated={(run) => {
            setCreating(false);
            openRun(
              run,
              `The ${monthLabel(run.period)} pay period is open: ${formatPeriodRange(run.periodStart, run.periodEnd)}. ${
                today >= run.approvableFrom
                  ? 'It has ended, so calculate the payslips, check them and approve.'
                  : 'Calculate payslips any time to see the figures so far.'
              }`,
            );
          }}
        />
      ) : null}

      {changingCycle && cycle !== null ? (
        <PayCycleDialog
          startDay={cycle}
          onClose={() => setChangingCycle(false)}
          onUnauthorized={onUnauthorized}
          onSaved={(saved) => {
            setChangingCycle(false);
            setCycle(saved);
            setNotice(`Pay cycle saved. ${describeCycle(saved)}. Pay periods already opened keep their dates.`);
          }}
        />
      ) : null}
    </>
  );
}
