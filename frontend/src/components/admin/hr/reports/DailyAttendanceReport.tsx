'use client';

import { CellStack, DataTable, type Column } from '@/components/admin/DataTable';
import { DAY_STATUS_LABELS, DAY_STATUS_TONE, WORK_MODE_LABELS, companyClock, minutesAsHours } from '@/lib/hr';
import { HR_REPORT_LIMITS, hrReportsApi, type AttendanceReportQuery, type DailyReportRow } from '@/lib/hrReports';
import { Tag } from '../../telecalling/shared';
import { dayTitle } from '../dashboard/AttendanceTrendCard';
import { ReportFrame } from './ReportFrame';
import type { ReportProps } from './reportProps';
import { ReportFilterBar } from './ReportFilterBar';
import { CsvLink, calendarRange, count, plural, rangeProblem, useServerData } from './shared';

/**
 * Daily attendance — one row per employee per day.
 *
 * Employee by employee, each person's days in order, so a page is a contiguous run of a
 * few people (the server pages it that way too). The screen takes up to 31 days — a
 * month of rows per person is already a lot of paging — and the CSV up to 93, so a
 * quarter can still be taken away as a file.
 *
 * Times are the company's wall clock (IST), whatever zone the browser is in: the times
 * the employee actually punched in India.
 */

const PAGE_SIZE = 50;

const COLUMNS: Column<DailyReportRow>[] = [
  {
    key: 'date',
    header: 'Day',
    width: '8rem',
    nowrap: true,
    render: (row) => dayTitle(row.date),
  },
  {
    key: 'employee',
    header: 'Employee',
    render: (row) => <CellStack primary={row.name} secondary={row.employeeCode} />,
  },
  {
    key: 'status',
    header: 'Status',
    width: '10rem',
    render: (row) => (
      <CellStack
        primary={<Tag tone={DAY_STATUS_TONE[row.status] ?? 'neutral'}>{DAY_STATUS_LABELS[row.status] ?? row.status}</Tag>}
        secondary={row.holiday ?? row.leaveType}
      />
    ),
  },
  {
    key: 'times',
    header: 'In – out',
    width: '9rem',
    nowrap: true,
    render: (row) =>
      row.firstIn ? (
        <span className="tc-mono hr-rep-times">
          {companyClock(row.firstIn)} – {row.lastOut ? companyClock(row.lastOut) : '…'}
        </span>
      ) : (
        <span className="tc-muted">—</span>
      ),
  },
  {
    key: 'worked',
    header: 'Worked',
    align: 'end',
    width: '6.5rem',
    nowrap: true,
    render: (row) => (row.workedMinutes === null ? <span className="tc-muted">—</span> : minutesAsHours(row.workedMinutes)),
  },
  {
    key: 'late',
    header: 'Late by',
    align: 'end',
    width: '6.5rem',
    nowrap: true,
    // Null when there was no attendance: not late is not the same as not there.
    render: (row) =>
      row.lateMinutes === null ? (
        <span className="tc-muted">—</span>
      ) : row.lateMinutes > 0 ? (
        <span className="tc-cell-warn">{minutesAsHours(row.lateMinutes)}</span>
      ) : (
        <span className="tc-muted">On time</span>
      ),
  },
  {
    key: 'where',
    header: 'Mode / site',
    width: '9.5rem',
    render: (row) =>
      row.workMode || row.site ? (
        <CellStack primary={row.workMode ? WORK_MODE_LABELS[row.workMode] ?? row.workMode : '—'} secondary={row.site} />
      ) : (
        <span className="tc-muted">—</span>
      ),
  },
  {
    key: 'flags',
    header: 'Flags',
    width: '8.5rem',
    render: (row) =>
      row.missingPunch || row.flagged ? (
        <span className="hr-rep-tags">
          {row.missingPunch ? <Tag tone="warn">Missing punch</Tag> : null}
          {row.flagged ? <Tag tone="warn">Flagged</Tag> : null}
        </span>
      ) : null,
  },
];

export function DailyAttendanceReport({ filters, onFilters, page, onPage, lookups, onUnauthorized, onClear, narrowed }: ReportProps) {
  const query: AttendanceReportQuery = {
    from: filters.from || undefined,
    to: filters.to || undefined,
    departmentId: filters.departmentId ?? undefined,
    locationId: filters.locationId ?? undefined,
    userId: filters.employee?.id,
  };

  const result = useServerData(
    JSON.stringify(['daily', query, page]),
    (signal) => hrReportsApi.daily({ ...query, page, pageSize: PAGE_SIZE }, signal),
    onUnauthorized,
    'Could not load the daily attendance.',
  );

  // The file allows a longer range than the screen, so it is judged against its own limit.
  const problem = rangeProblem(filters.from, filters.to, HR_REPORT_LIMITS.dailyCsvDays);

  return (
    <>
      <ReportFilterBar
        idPrefix="hr-rep-daily"
        fields={{
          range: {
            hint: `Up to ${HR_REPORT_LIMITS.dailyJsonDays} days on screen; the CSV covers up to ${HR_REPORT_LIMITS.dailyCsvDays}.`,
          },
          department: true,
          site: true,
          employee: true,
        }}
        filters={filters}
        onChange={onFilters}
        lookups={lookups}
        errors={result.fieldErrors}
        onUnauthorized={onUnauthorized}
      />

      {/*
        A range the table refuses can still be a range the file accepts — offer it, so
        "too long for the screen" is not a dead end.
      */}
      {!result.data && result.status === 400 && !problem ? (
        <p className="hr-rep-note">
          This range is too long to show on screen, but it can be downloaded.{' '}
          <CsvLink href={hrReportsApi.csvUrl('daily', query)} />
        </p>
      ) : null}

      <ReportFrame
        result={result}
        page={page}
        onPage={onPage}
        noun="row"
        caption={(data) => `${plural(data.total, 'row')} (one per employee per day) · ${calendarRange(data.from, data.to)}`}
        download={<CsvLink href={hrReportsApi.csvUrl('daily', query)} problem={problem} />}
        empty={{
          title: 'No days in this report',
          message: narrowed
            ? 'Nobody matches these filters for the range. Clear them to see everyone.'
            : 'Approved employees appear here once they exist.',
        }}
        onClear={narrowed ? onClear : undefined}
        restricted={{ title: 'Not available for your role', message: 'Your role cannot read attendance reports.' }}
      >
        {(data) => (
          <DataTable
            rows={data.items}
            rowKey={(row) => `${row.userId}:${row.date}`}
            columns={COLUMNS}
            minWidth="68rem"
            caption={`Daily attendance, ${calendarRange(data.from, data.to)}, ${count(data.total)} rows`}
          />
        )}
      </ReportFrame>
    </>
  );
}
