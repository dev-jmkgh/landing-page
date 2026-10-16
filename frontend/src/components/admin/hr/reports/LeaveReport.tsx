'use client';

import { CellStack, DataTable, type Column } from '@/components/admin/DataTable';
import { formatDays } from '@/lib/hr';
import { hrReportsApi, type LeaveReportCell, type LeaveReportQuery, type LeaveReportRow } from '@/lib/hrReports';
import { ReportFrame } from './ReportFrame';
import type { ReportProps } from './reportProps';
import { ReportFilterBar } from './ReportFilterBar';
import { yearsBack } from './filters';
import { CsvLink, companyToday, plural, useServerData } from './shared';

/**
 * Leave — one row per employee for a year, one column per leave type.
 *
 * A TRACKED type shows what is left, with the used, pending and entitled days under it.
 * An UNTRACKED type — no allocation and no annual quota, and always work from home and
 * field work — shows the days used and NO balance: there is no entitlement to subtract
 * from, and a "0 left" would be an invented figure that reads as "has run out".
 *
 * The columns come from the rows: every row of a year carries the same type list (every
 * active type, plus a retired one that still has requests that year), in the server's
 * sort order. The CSV is the long form — one line per employee per type — so a
 * spreadsheet's columns never depend on which types exist.
 */

const PAGE_SIZE = 25;

function days(value: number): string {
  return `${formatDays(value)} ${value === 1 ? 'day' : 'days'}`;
}

function TypeCell({ cell }: { cell: LeaveReportCell | undefined }) {
  if (!cell) return <span className="tc-muted">—</span>;

  if (!cell.tracked || cell.entitled === null || cell.available === null) {
    return (
      <CellStack
        primary={cell.used > 0 ? `${days(cell.used)} used` : <span className="tc-muted">None used</span>}
        secondary={cell.pending > 0 ? `${days(cell.pending)} pending` : 'No balance kept'}
      />
    );
  }

  const left =
    cell.available < 0 ? (
      // Approved past the entitlement — said as "over", not as a negative balance.
      <span className="tc-cell-bad">{days(-cell.available)} over</span>
    ) : (
      `${days(cell.available)} left`
    );

  return (
    <CellStack
      primary={left}
      secondary={`${formatDays(cell.used)} used${cell.pending > 0 ? ` · ${formatDays(cell.pending)} pending` : ''} of ${formatDays(cell.entitled)}`}
    />
  );
}

/** The type list of a page, in the order the server sorted it. */
function typesOf(rows: LeaveReportRow[]): Array<Pick<LeaveReportCell, 'leaveTypeId' | 'code' | 'name' | 'tracked' | 'kind'>> {
  const seen = new Map<number, Pick<LeaveReportCell, 'leaveTypeId' | 'code' | 'name' | 'tracked' | 'kind'>>();
  for (const row of rows) {
    for (const cell of row.types) {
      const known = seen.get(cell.leaveTypeId);
      // "Tracked" for the column means tracked for anybody on the page.
      if (!known) seen.set(cell.leaveTypeId, { leaveTypeId: cell.leaveTypeId, code: cell.code, name: cell.name, tracked: cell.tracked, kind: cell.kind });
      else if (cell.tracked && !known.tracked) seen.set(cell.leaveTypeId, { ...known, tracked: true });
    }
  }
  return [...seen.values()];
}

function columnsFor(rows: LeaveReportRow[]): Column<LeaveReportRow>[] {
  return [
    {
      key: 'employee',
      header: 'Employee',
      render: (row) => (
        <CellStack primary={row.name} secondary={[row.employeeCode, row.departmentName].filter(Boolean).join(' · ')} />
      ),
    },
    ...typesOf(rows).map(
      (type): Column<LeaveReportRow> => ({
        key: `type-${type.leaveTypeId}`,
        header: (
          <span className="hr-rep-type-head" title={type.name}>
            {type.name}
            <span className="hr-rep-type-head__code">{type.code}</span>
          </span>
        ),
        width: '9.5rem',
        render: (row) => <TypeCell cell={row.types.find((cell) => cell.leaveTypeId === type.leaveTypeId)} />,
      }),
    ),
  ];
}

export function LeaveReport({ filters, onFilters, page, onPage, lookups, onUnauthorized, onClear, narrowed }: ReportProps) {
  const query: LeaveReportQuery = {
    year: filters.year,
    departmentId: filters.departmentId ?? undefined,
    userId: filters.employee?.id,
  };

  const result = useServerData(
    JSON.stringify(['leave', query, page]),
    (signal) => hrReportsApi.leave({ ...query, page, pageSize: PAGE_SIZE }, signal),
    onUnauthorized,
    'Could not load the leave report.',
  );

  const thisYear = Number(companyToday().slice(0, 4));

  return (
    <>
      <ReportFilterBar
        idPrefix="hr-rep-leave"
        // Next year too: leave can be applied for up to a year ahead.
        fields={{ years: yearsBack(thisYear + 1, 6), department: true, employee: true }}
        filters={filters}
        onChange={onFilters}
        lookups={lookups}
        errors={result.fieldErrors}
        onUnauthorized={onUnauthorized}
      />

      <ReportFrame
        result={result}
        page={page}
        onPage={onPage}
        noun="employee"
        caption={(data) =>
          `${plural(data.total, 'employee')} · ${data.year}. Balances count requests that start in the year; untracked types show days used and no balance.`
        }
        download={<CsvLink href={hrReportsApi.csvUrl('leave', query)} />}
        empty={{
          title: 'No employees in this report',
          message: narrowed
            ? 'Nobody matches these filters for the year. Clear them to see everyone.'
            : 'Employees appear here once they have an approved account for the year.',
        }}
        onClear={narrowed ? onClear : undefined}
        restricted={{ title: 'Not available for your role', message: 'Your role cannot read leave reports.' }}
      >
        {(data) => {
          const columns = columnsFor(data.items);
          return (
            <DataTable
              rows={data.items}
              rowKey={(row) => row.userId}
              columns={columns}
              minWidth={`${14 + (columns.length - 1) * 9.5}rem`}
              caption={`Leave balances and usage per employee for ${data.year}`}
            />
          );
        }}
      </ReportFrame>
    </>
  );
}
