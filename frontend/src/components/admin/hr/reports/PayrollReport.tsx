'use client';

import { CellStack, DataTable, type Column } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { formatMonth } from '@/lib/hr';
import { formatRupees, hrReportsApi, type PayrollRunStatus, type PayrollRunSummary, type PayrollYearReport } from '@/lib/hrReports';
import { formatDateTime } from '@/lib/telecalling';
import { EmptyPanel, StatCard, StatGrid, Tag, TableSkeleton } from '../../telecalling/shared';
import { yearsBack } from './filters';
import type { ReportProps } from './reportProps';
import { ReportFilterBar } from './ReportFilterBar';
import { CsvLink, RestrictedPanel, ResultsHead, companyToday, count, plural, useServerData } from './shared';

/**
 * Payroll by year — ADMINISTRATORS ONLY, like every payroll read: salary is sensitive.
 *
 * A supervisor is refused by the server (403) and sees a calm explanation rather than an
 * error, because no retry will change it. At most twelve runs a year, so the report is
 * bounded and not paged.
 *
 * The year's totals count APPROVED runs only. A draft or processed run can still be
 * recomputed, so adding it to the year would report money nobody has signed off; those
 * runs are listed, with their status, but are not in the totals.
 */

const STATUS_LABELS: Record<PayrollRunStatus, string> = {
  draft: 'Draft',
  processed: 'Processed',
  approved: 'Approved',
};

const STATUS_TONE: Record<PayrollRunStatus, 'neutral' | 'progress' | 'good'> = {
  draft: 'neutral',
  processed: 'progress',
  approved: 'good',
};

const COLUMNS: Column<PayrollRunSummary>[] = [
  { key: 'period', header: 'Period', render: (run) => formatMonth(run.period) },
  {
    key: 'status',
    header: 'Status',
    width: '8rem',
    render: (run) => <Tag tone={STATUS_TONE[run.status] ?? 'neutral'}>{STATUS_LABELS[run.status] ?? run.status}</Tag>,
  },
  { key: 'employees', header: 'Payslips', align: 'end', width: '7rem', render: (run) => count(run.employeeCount) },
  { key: 'gross', header: 'Gross', align: 'end', width: '9.5rem', nowrap: true, render: (run) => formatRupees(run.totalGross) },
  {
    key: 'deductions',
    header: 'Deductions',
    align: 'end',
    width: '9.5rem',
    nowrap: true,
    render: (run) => formatRupees(run.totalDeductions),
  },
  { key: 'net', header: 'Net pay', align: 'end', width: '9.5rem', nowrap: true, render: (run) => formatRupees(run.totalNet) },
  {
    key: 'approved',
    header: 'Approved',
    width: '13rem',
    render: (run) =>
      run.approvedAt ? (
        <CellStack primary={formatDateTime(run.approvedAt)} secondary={run.approvedByName ? `by ${run.approvedByName}` : null} />
      ) : (
        <span className="tc-muted">Not yet</span>
      ),
  },
];

export function PayrollReport({ filters, onFilters, lookups, onUnauthorized }: ReportProps) {
  const year = filters.year;
  const result = useServerData<PayrollYearReport>(
    `payroll:${year}`,
    (signal) => hrReportsApi.payroll(year, signal),
    onUnauthorized,
    'Could not load the payroll report.',
  );
  const thisYear = Number(companyToday().slice(0, 4));

  if (result.status === 403) {
    return (
      <RestrictedPanel
        title="Payroll is for administrators"
        message="Salary figures are visible to administrators only. Ask an administrator if you need this report."
      />
    );
  }

  const data = result.data;

  return (
    <>
      <ReportFilterBar
        idPrefix="hr-rep-pay"
        fields={{ years: yearsBack(thisYear, 5) }}
        filters={filters}
        onChange={onFilters}
        lookups={lookups}
        onUnauthorized={onUnauthorized}
      />

      {result.error ? (
        <FormAlert variant="error">
          {result.error}{' '}
          <button type="button" className="tc-alert-action" onClick={result.reload}>
            Try again
          </button>
        </FormAlert>
      ) : null}

      {data ? (
        <LoadingOverlay busy={result.loading} label="Updating the report…">
          <div>
            <ResultsHead actions={<CsvLink href={hrReportsApi.csvUrl('payroll', { year })} />}>
              {plural(data.items.length, 'payroll run')} in {data.year} · totals count approved runs only
            </ResultsHead>

            {/* Money tiles: a smaller figure, so ₹ amounts in lakhs fit the tile instead of being cut. */}
            <div className="hr-rep-money">
              <StatGrid>
                <StatCard value={count(data.approvedTotals.runs)} label="Approved runs" tone="good" icon="check" />
                <StatCard
                  value={count(data.approvedTotals.payslips)}
                  label="Payslips issued"
                  hint="Counted per payslip, not per person"
                />
                <StatCard value={formatRupees(data.approvedTotals.gross)} label="Gross pay" icon="wallet" />
                <StatCard value={formatRupees(data.approvedTotals.deductions)} label="Deductions" />
                <StatCard value={formatRupees(data.approvedTotals.net)} label="Net pay" tone="good" icon="wallet" />
              </StatGrid>
            </div>

            <div className="hr-rep-gap" />

            {data.items.length === 0 ? (
              <EmptyPanel title={`No payroll runs in ${data.year}`} message="Runs appear here once they are created under Payroll." />
            ) : (
              <DataTable
                rows={data.items}
                rowKey={(run) => run.id}
                columns={COLUMNS}
                minWidth="66rem"
                caption={`Payroll runs in ${data.year}`}
              />
            )}
          </div>
        </LoadingOverlay>
      ) : result.loading ? (
        <TableSkeleton rows={6} />
      ) : null}
    </>
  );
}
