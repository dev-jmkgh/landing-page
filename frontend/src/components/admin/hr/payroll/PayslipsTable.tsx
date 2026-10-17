'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import {
  formatDays,
  formatInr,
  monthLabel,
  payrollApi,
  type PayrollPage,
  type PayrollRun,
  type Payslip,
} from '@/lib/hrPayroll';
import { EmptyPanel, Pager, TableSkeleton, Tag } from '../../telecalling/shared';
import { ConfirmDialog, isAbort, plural, readFailure } from './shared';

/**
 * The payslips of one pay period: a paged, searchable table whose rows open to show the
 * day counts and every earning and deduction line.
 *
 * EVERY FIGURE HERE IS THE SERVER'S. Gross, loss of pay, deductions and net are read off
 * the payslip exactly as the calculation produced them; nothing is added up or prorated
 * in the browser. A payslip is a record of what is paid, and a second calculation that
 * could round differently is how a paisa dispute starts.
 *
 * PROVISIONAL PAYSLIPS. A payslip calculated while its period was still running has
 * `remainingDays` > 0: days still to come, neither paid nor loss of pay. Its row is
 * tagged "Provisional" and says how many days are still to come, so "12 of 30 days paid"
 * is not read as eighteen days of loss of pay.
 *
 * PAYING IN FULL. Absent days and unpaid leave are loss of pay. An administrator can pay
 * one employee in full for the period instead — with a reason, audited — from that
 * payslip's detail; the period is recalculated on the spot. The row is then tagged "Paid
 * in full" and its detail says how many LOP days were waived and why.
 *
 * WHY NOT `DataTable`: it renders one `<tr>` per record and has no full-width detail row,
 * and a payslip's detail — eleven day counts and two tables of lines — does not fit into
 * a cell. This uses the same `.data-table` markup and the same column model (one `align`
 * shared by header and cells, widths in a `<colgroup>`), plus a detail row spanning every
 * column. If `DataTable` gains an expandable row, this should move onto it.
 */

const PAGE_SIZE = 20;

type Column = {
  key: string;
  header: ReactNode;
  align?: 'start' | 'end';
  width?: string;
  nowrap?: boolean;
  render: (slip: Payslip) => ReactNode;
};

/**
 * The day counts, in the order the payslip PDF prints them, then the two that explain
 * the rest. Each hint says what the count means for pay, because "untracked" and "not
 * employed" are not words an administrator should have to guess at.
 */
type DayCountKey =
  | 'daysInPeriod'
  | 'paidDays'
  | 'lopDays'
  | 'lopWaivedDays'
  | 'remainingDays'
  | 'presentDays'
  | 'paidLeaveDays'
  | 'unpaidLeaveDays'
  | 'absentDays'
  | 'holidayDays'
  | 'weeklyOffDays'
  | 'untrackedDays'
  | 'unemployedDays';

/**
 * `onlyWhenAboveZero` keeps "Still to come" off every final payslip, where it is always
 * 0 and would only raise the question of what it means.
 */
const DAY_COUNTS: { key: DayCountKey; label: string; hint?: string; onlyWhenAboveZero?: boolean }[] = [
  { key: 'daysInPeriod', label: 'Days in period' },
  { key: 'paidDays', label: 'Paid days', hint: 'Days in period less not-employed and LOP days' },
  { key: 'lopDays', label: 'LOP days', hint: 'Unpaid leave plus absent days' },
  {
    key: 'lopWaivedDays',
    label: 'LOP waived',
    hint: 'Paid in full by an administrator',
    onlyWhenAboveZero: true,
  },
  {
    key: 'remainingDays',
    label: 'Still to come',
    hint: 'After the calculation; not paid and not LOP yet',
    onlyWhenAboveZero: true,
  },
  { key: 'presentDays', label: 'Present' },
  { key: 'paidLeaveDays', label: 'Paid leave' },
  { key: 'unpaidLeaveDays', label: 'Unpaid leave' },
  { key: 'absentDays', label: 'Absent' },
  { key: 'holidayDays', label: 'Holidays' },
  { key: 'weeklyOffDays', label: 'Weekly offs' },
  // Only older calculations have these: days before tracking began are now judged like any other.
  {
    key: 'untrackedDays',
    label: 'Untracked',
    hint: 'Before attendance tracking began; paid (older calculation)',
    onlyWhenAboveZero: true,
  },
  { key: 'unemployedDays', label: 'Not employed', hint: 'Before joining or after leaving; not paid, not LOP' },
];

export function PayslipsTable({
  run,
  refreshToken,
  onRunChanged,
  onUnauthorized,
  onRestricted,
}: {
  run: PayrollRun;
  /** Bumped by the run screen after a re-process, so the rows are read again. */
  refreshToken: number;
  /** Paying in full recalculates the period; the run screen takes the new totals. */
  onRunChanged: (run: PayrollRun) => void;
  onUnauthorized: () => void;
  onRestricted: () => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<PayrollPage<Payslip> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  /* Paying in full: whose payslip, the reason being typed, and the request in flight. */
  const [fullPayFor, setFullPayFor] = useState<Payslip | null>(null);
  const [stopping, setStopping] = useState<Payslip | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // An approved period's payslips are published: nothing about them changes any more.
  const canEdit = run.status !== 'approved';

  const abort = useRef<AbortController | null>(null);

  /*
   * The search is applied 350ms after typing stops, and the page goes back to 1 in the
   * same step — page 3 of "all payslips" is not page 3 of "payslips matching Anita".
   */
  useEffect(() => {
    const next = search.trim();
    if (next === query) return undefined;
    const timer = window.setTimeout(() => {
      setQuery(next);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setLoading(true);
    setError(null);

    try {
      setData(
        await payrollApi.listPayslips(
          run.id,
          { q: query || undefined, page, pageSize: PAGE_SIZE },
          controller.signal,
        ),
      );
    } catch (caught) {
      if (isAbort(caught)) return;
      setError(readFailure(caught, { onUnauthorized, onRestricted }, 'Could not load the payslips.'));
    } finally {
      // A request replaced by a newer one must not end the newer one's loading state.
      if (abort.current === controller) setLoading(false);
    }
  }, [run.id, query, page, onUnauthorized, onRestricted]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => () => abort.current?.abort(), []);

  // A page past the end — payslips removed by a re-process — goes back to the first page
  // rather than claiming the run is empty.
  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(1);
  }, [data, page]);

  const periodName = monthLabel(run.period);

  const payInFull = async () => {
    if (!fullPayFor) return;
    const text = reason.trim();
    if (text.length < 5) {
      setActionError('Say why this employee is being paid in full.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await payrollApi.setFullPay(run.id, fullPayFor.userId, text);
      setNotice(
        `${fullPayFor.employeeName} is paid in full for this period. The payslips were recalculated.`,
      );
      setFullPayFor(null);
      setReason('');
      onRunChanged(result.run);
      void load();
    } catch (caught) {
      setActionError(readFailure(caught, { onUnauthorized, onRestricted }, 'Could not pay in full.'));
    } finally {
      setBusy(false);
    }
  };

  const stopFullPay = async () => {
    if (!stopping) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await payrollApi.clearFullPay(run.id, stopping.userId);
      setNotice(`${stopping.employeeName}’s loss of pay applies again. The payslips were recalculated.`);
      setStopping(null);
      onRunChanged(result.run);
      void load();
    } catch (caught) {
      setActionError(readFailure(caught, { onUnauthorized, onRestricted }, 'Could not change that.'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: Column[] = [
    {
      key: 'employee',
      header: 'Employee',
      render: (slip) => {
        const open = expanded.has(slip.id);
        return (
          <div className="hr-pay-slip-head">
            <button
              type="button"
              className="hr-pay-expander"
              aria-expanded={open}
              aria-controls={`hr-payslip-${slip.id}`}
              onClick={() => toggle(slip.id)}
            >
              <Icon name="chevronDown" size={16} className="hr-pay-expander__icon" />
              <span className="sr-only">{open ? 'Hide' : 'Show'} the payslip details for </span>
              <span className="hr-pay-expander__name">{slip.employeeName}</span>
            </button>
            <span className="hr-pay-slip-head__meta">
              <span className="tc-muted tc-mono">{slip.employeeCode}</span>
              {slip.remainingDays > 0 ? <Tag tone="progress">Provisional</Tag> : null}
              {slip.fullPayReason ? <Tag tone="good">Paid in full</Tag> : null}
            </span>
          </div>
        );
      },
    },
    {
      key: 'department',
      header: 'Department',
      width: '11rem',
      render: (slip) => (
        <div className="cell-stack">
          <span>{slip.departmentName ?? <span className="tc-muted">No department</span>}</span>
          {slip.designationName ? (
            <span className="cell-stack__secondary">{slip.designationName}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'days',
      header: 'Days paid',
      align: 'end',
      width: '10.5rem',
      nowrap: true,
      render: (slip) => (
        <div className="cell-stack">
          <span>
            {formatDays(slip.paidDays)} of {formatDays(slip.daysInPeriod)}
          </span>
          {slip.lopDays > 0 ? (
            <span className="cell-stack__secondary tc-cell-warn">{formatDays(slip.lopDays)} LOP</span>
          ) : null}
          {slip.lopWaivedDays > 0 ? (
            <span className="cell-stack__secondary">{formatDays(slip.lopWaivedDays)} LOP waived</span>
          ) : null}
          {slip.remainingDays > 0 ? (
            <span className="cell-stack__secondary">
              Still to come: {formatDays(slip.remainingDays)} {slip.remainingDays === 1 ? 'day' : 'days'}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'gross',
      header: 'Gross',
      align: 'end',
      width: '9rem',
      nowrap: true,
      render: (slip) => formatInr(slip.grossEarnings),
    },
    {
      key: 'deductions',
      header: 'Deductions',
      align: 'end',
      width: '8.5rem',
      nowrap: true,
      render: (slip) => formatInr(slip.totalDeductions),
    },
    {
      key: 'net',
      header: 'Net pay',
      align: 'end',
      width: '9rem',
      nowrap: true,
      render: (slip) => <strong className="hr-pay-net">{formatInr(slip.netPay)}</strong>,
    },
    {
      key: 'pdf',
      header: <span className="sr-only">Payslip PDF</span>,
      align: 'end',
      width: '5.5rem',
      nowrap: true,
      render: (slip) => (
        /*
         * A plain link in a new tab: the server answers with the PDF inline, and the
         * admin session cookie travels with a same-site GET. A new tab keeps this run
         * open behind it, and a session that has expired shows its sign-in message there
         * rather than replacing the screen.
         */
        <a
          className="btn btn--outline btn--sm"
          href={payrollApi.payslipPdfUrl(slip.id)}
          target="_blank"
          rel="noopener"
          aria-label={`PDF payslip for ${slip.employeeName} (opens in a new tab)`}
        >
          PDF
        </a>
      ),
    },
  ];

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="hr-pay-section" aria-labelledby="hr-pay-payslips-title">
      <div className="tc-panel-head">
        <h3 className="tc-section-title" id="hr-pay-payslips-title" style={{ margin: 0 }}>
          Payslips{run.provisional ? ' so far' : ''}
        </h3>
        <div className="field hr-pay-search">
          <label className="field__label" htmlFor="hr-pay-payslip-search">
            Search payslips
          </label>
          <input
            id="hr-pay-payslip-search"
            className="input"
            type="search"
            value={search}
            placeholder="Name or employee code"
            maxLength={120}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {error ? <FormAlert variant="error">{error}</FormAlert> : null}
      {notice ? <FormAlert variant="success">{notice}</FormAlert> : null}

      {loading && !data ? (
        <TableSkeleton rows={4} />
      ) : !data ? (
        <EmptyPanel
          title="Payslips not loaded"
          message="The payslips of this pay period could not be loaded."
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : data.items.length === 0 ? (
        query ? (
          <EmptyPanel
            title="No payslips match"
            message={`Nobody in this pay period matches “${query}”. Search by name or employee code.`}
            actionLabel="Clear the search"
            onAction={() => setSearch('')}
          />
        ) : (
          <EmptyPanel
            title="No payslips in this pay period"
            message={
              run.exclusions.length > 0
                ? 'Nobody is included in this calculation. “Not included” above shows who was left out and why: give them a salary structure, then recalculate.'
                : 'Nobody was employed during this period, so there is nobody to pay.'
            }
          />
        )
      ) : (
        <LoadingOverlay busy={loading} label="Updating…">
          <div className="table-wrap hr-pay-table-wrap">
            <table className="data-table" style={{ minWidth: '66rem' }}>
              <caption className="sr-only">
                Payslips for this pay period{run.provisional ? ', figures so far' : ''}. Each
                employee’s name opens the day counts and the earning and deduction lines.
              </caption>
              <colgroup>
                {columns.map((column) => (
                  <col key={column.key} style={column.width ? { width: column.width } : undefined} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      style={{ textAlign: column.align ?? 'start' }}
                      data-nowrap={column.nowrap ? 'true' : undefined}
                    >
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((slip) => (
                  <Fragment key={slip.id}>
                    <tr data-expanded={expanded.has(slip.id) ? 'true' : undefined}>
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          style={{ textAlign: column.align ?? 'start' }}
                          data-nowrap={column.nowrap ? 'true' : undefined}
                        >
                          {column.render(slip)}
                        </td>
                      ))}
                    </tr>
                    {expanded.has(slip.id) ? (
                      <tr className="hr-pay-detail-row" id={`hr-payslip-${slip.id}`}>
                        <td colSpan={columns.length}>
                          <PayslipDetail
                            slip={slip}
                            canEdit={canEdit}
                            onPayInFull={() => {
                              setNotice(null);
                              setActionError(null);
                              setReason('');
                              setFullPayFor(slip);
                            }}
                            onStopFullPay={() => {
                              setNotice(null);
                              setActionError(null);
                              setStopping(slip);
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <Pager
            page={data.page}
            totalPages={totalPages}
            total={data.total}
            noun="payslip"
            busy={loading}
            onChange={setPage}
          />
        </LoadingOverlay>
      )}

      {fullPayFor ? (
        <ConfirmDialog
          title={`Pay ${fullPayFor.employeeName} in full?`}
          confirmLabel="Pay in full"
          busyLabel="Recalculating…"
          busy={busy}
          error={actionError}
          onConfirm={() => void payInFull()}
          onCancel={() => {
            setFullPayFor(null);
            setActionError(null);
          }}
        >
          <p>
            Their {plural(fullPayFor.lopDays, 'day')} of loss of pay in this pay period ({periodName}) will be
            waived and they are paid for every day employed. The absences still show on the payslip. This is
            recorded in the audit log with your name and the reason, and can be undone until the period is
            approved.
          </p>
          <div className="field" style={{ marginTop: 'var(--space-3)' }}>
            <label className="field__label" htmlFor="hr-pay-full-reason">
              Reason
            </label>
            <textarea
              id="hr-pay-full-reason"
              className="input"
              rows={3}
              maxLength={500}
              value={reason}
              placeholder="e.g. Approved by management: joined before the HR app was in use"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </ConfirmDialog>
      ) : null}

      {stopping ? (
        <ConfirmDialog
          title={`Stop paying ${stopping.employeeName} in full?`}
          confirmLabel="Apply loss of pay again"
          busyLabel="Recalculating…"
          busy={busy}
          error={actionError}
          onConfirm={() => void stopFullPay()}
          onCancel={() => {
            setStopping(null);
            setActionError(null);
          }}
        >
          <p>
            Their {plural(stopping.lopWaivedDays, 'day')} of loss of pay will apply again and the payslips are
            recalculated.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

/**
 * One payslip opened up: the day counts, then earnings and deductions with the full
 * monthly amount beside what was actually paid or deducted.
 *
 * Sized to the visible width of the table's scroll box (see `.hr-pay-detail` in the
 * stylesheet), so on a phone it stays readable without scrolling sideways across a
 * 64rem table.
 */
function PayslipDetail({
  slip,
  canEdit,
  onPayInFull,
  onStopFullPay,
}: {
  slip: Payslip;
  /** False once the period is approved. */
  canEdit: boolean;
  onPayInFull: () => void;
  onStopFullPay: () => void;
}) {
  const earnings = slip.lines.filter((line) => line.kind === 'earning');
  const deductions = slip.lines.filter((line) => line.kind === 'deduction');

  return (
    <div className="hr-pay-detail">
      <section className="hr-pay-detail__block" aria-label={`Days for ${slip.employeeName}`}>
        <h4 className="hr-pay-detail__title">Days</h4>
        <dl className="hr-pay-days">
          {DAY_COUNTS.filter((count) => !count.onlyWhenAboveZero || slip[count.key] > 0).map((count) => (
            <div
              key={count.key}
              className="hr-pay-days__item"
              data-tone={
                count.key === 'lopDays' && slip.lopDays > 0
                  ? 'warn'
                  : count.key === 'remainingDays'
                    ? 'progress'
                    : undefined
              }
            >
              <dt>{count.label}</dt>
              <dd>{formatDays(slip[count.key])}</dd>
              {count.hint ? (
                <span className="hr-pay-days__hint">
                  {count.key === 'paidDays' && slip.remainingDays > 0
                    ? 'So far: days in period less not-employed, LOP and days still to come'
                    : count.hint}
                </span>
              ) : null}
            </div>
          ))}
        </dl>
        {slip.remainingDays > 0 ? (
          <p className="hr-pay-detail__so-far">
            <Icon name="clock" size={14} />
            Provisional: paid amounts cover the days so far.{' '}
            {plural(slip.remainingDays, 'day')} still to come {slip.remainingDays === 1 ? 'is' : 'are'} not
            counted yet.
          </p>
        ) : null}
      </section>

      <div className="hr-pay-detail__lines">
        <section className="hr-pay-detail__block" aria-label={`Earnings for ${slip.employeeName}`}>
          <h4 className="hr-pay-detail__title">Earnings</h4>
          <div className="hr-pay-lines-scroll">
            <table className="hr-pay-lines">
              <thead>
                <tr>
                  <th scope="col">Component</th>
                  <th scope="col">Full month</th>
                  <th scope="col">Paid</th>
                </tr>
              </thead>
              <tbody>
                {earnings.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="tc-muted">
                      No earnings on this payslip.
                    </td>
                  </tr>
                ) : (
                  earnings.map((line, index) => (
                    <tr key={`${line.label}-${index}`}>
                      <th scope="row">{line.label}</th>
                      <td>{formatInr(line.fullAmount)}</td>
                      <td>{formatInr(line.amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Gross earnings</th>
                  <td />
                  <td>{formatInr(slip.grossEarnings)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {slip.lopAmount > 0 ? (
            /*
             * A note rather than a row: the Paid column is already after loss of pay, so a
             * "Loss of pay" row under Gross would read as a second deduction.
             */
            <p className="hr-pay-detail__lop">
              Paid amounts are after loss of pay of <strong>{formatInr(slip.lopAmount)}</strong> for{' '}
              {plural(slip.lopDays, 'LOP day')}.
            </p>
          ) : null}
        </section>

        <section className="hr-pay-detail__block" aria-label={`Deductions for ${slip.employeeName}`}>
          <h4 className="hr-pay-detail__title">Deductions</h4>
          <div className="hr-pay-lines-scroll">
            <table className="hr-pay-lines">
              <thead>
                <tr>
                  <th scope="col">Component</th>
                  <th scope="col">Full month</th>
                  <th scope="col">Deducted</th>
                </tr>
              </thead>
              <tbody>
                {deductions.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="tc-muted">
                      No deductions on this payslip.
                    </td>
                  </tr>
                ) : (
                  deductions.map((line, index) => (
                    <tr key={`${line.label}-${index}`}>
                      <th scope="row">{line.label}</th>
                      <td>{formatInr(line.fullAmount)}</td>
                      <td>{formatInr(line.amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total deductions</th>
                  <td />
                  <td>{formatInr(slip.totalDeductions)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="hr-pay-detail__net">
            <span>Net pay</span>
            <strong>{formatInr(slip.netPay)}</strong>
          </p>
        </section>
      </div>

      {/* Paying in full: an administrator's decision, shown with its reason. */}
      {slip.fullPayReason ? (
        <div className="hr-pay-fullpay" data-state="on">
          <p>
            <strong>Paid in full.</strong> {plural(slip.lopWaivedDays, 'LOP day')} waived: {slip.fullPayReason}
          </p>
          {canEdit ? (
            <button type="button" className="btn btn--outline btn--sm" onClick={onStopFullPay}>
              Stop paying in full
            </button>
          ) : null}
        </div>
      ) : canEdit && slip.lopDays > 0 ? (
        <div className="hr-pay-fullpay">
          <p>
            {plural(slip.lopDays, 'LOP day')} reduce this payslip. To pay this employee for the whole period instead,
            pay them in full — you will be asked why.
          </p>
          <button type="button" className="btn btn--outline btn--sm" onClick={onPayInFull}>
            Pay in full…
          </button>
        </div>
      ) : null}
    </div>
  );
}
