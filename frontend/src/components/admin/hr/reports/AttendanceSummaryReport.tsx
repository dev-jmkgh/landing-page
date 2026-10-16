'use client';

import { CellStack, DataTable, type Column } from '@/components/admin/DataTable';
import { minutesAsHours } from '@/lib/hr';
import { HR_REPORT_LIMITS, hrReportsApi, type AttendanceReportQuery, type AttendanceReportRow } from '@/lib/hrReports';
import { Tag } from '../../telecalling/shared';
import { ReportFrame } from './ReportFrame';
import type { ReportProps } from './reportProps';
import { ReportFilterBar } from './ReportFilterBar';
import { CsvLink, calendarRange, count, plural, rangeProblem, useServerData } from './shared';

/**
 * Attendance summary — one row per employee over a range of up to 93 days.
 *
 * Every count comes from the server's day classifier, the one leave and payroll use, so
 * a day this report calls absent is a day payroll deducted for. Days the classifier could
 * not judge (still to come, before tracking began, outside employment) are named on the
 * employee's row rather than folded into a column — they are not absences.
 */

const PAGE_SIZE = 25;

/** A zero, recessive, so the columns' real figures stand out; the figure otherwise. */
function quiet(value: number) {
  return value === 0 ? <span className="tc-muted">0</span> : count(value);
}

const COLUMNS: Column<AttendanceReportRow>[] = [
  {
    key: 'employee',
    header: 'Employee',
    render: (row) => {
      const notes = [
        row.upcoming > 0 ? `${plural(row.upcoming, 'day')} still to come` : null,
        row.untracked > 0 ? `${plural(row.untracked, 'day')} before tracking began` : null,
        row.notEmployed > 0 ? `${plural(row.notEmployed, 'day')} outside employment` : null,
      ].filter((note): note is string => note !== null);

      return (
        <CellStack
          primary={row.name}
          secondary={[row.employeeCode, row.departmentName].filter(Boolean).join(' · ')}
        >
          {notes.map((note) => (
            <Tag key={note}>{note}</Tag>
          ))}
        </CellStack>
      );
    },
  },
  {
    key: 'present',
    header: 'Present',
    align: 'end',
    width: '7.5rem',
    render: (row) => (
      <CellStack primary={count(row.present)} secondary={row.halfDay > 0 ? `+ ${plural(row.halfDay, 'half day')}` : null} />
    ),
  },
  {
    key: 'late',
    header: 'Late',
    align: 'end',
    width: '6.5rem',
    render: (row) => (
      <CellStack
        primary={row.late > 0 ? <span className="tc-cell-warn">{count(row.late)}</span> : quiet(0)}
        secondary={row.totalLateMinutes > 0 ? `${minutesAsHours(row.totalLateMinutes)} late` : null}
      />
    ),
  },
  {
    key: 'absent',
    header: 'Absent',
    align: 'end',
    width: '6rem',
    render: (row) => (row.absent > 0 ? <span className="tc-cell-bad">{count(row.absent)}</span> : quiet(0)),
  },
  { key: 'leave', header: 'On leave', align: 'end', width: '6.5rem', render: (row) => quiet(row.onLeave) },
  {
    key: 'off',
    header: 'Days off',
    align: 'end',
    width: '7.5rem',
    render: (row) => (
      <CellStack
        primary={quiet(row.holidays + row.weeklyOffs)}
        secondary={row.holidays + row.weeklyOffs > 0 ? `${count(row.holidays)} hol · ${count(row.weeklyOffs)} weekly` : null}
      />
    ),
  },
  {
    key: 'remote',
    header: 'WFH / field',
    align: 'end',
    width: '7rem',
    render: (row) =>
      row.wfhDays + row.fieldDays > 0 ? (
        <CellStack primary={count(row.wfhDays + row.fieldDays)} secondary={`${count(row.wfhDays)} WFH · ${count(row.fieldDays)} field`} />
      ) : (
        quiet(0)
      ),
  },
  {
    key: 'worked',
    header: 'Worked',
    align: 'end',
    width: '8.5rem',
    render: (row) =>
      // No day with hours is "not recorded", which is not the same as zero hours.
      row.averageWorkedMinutes === null ? (
        <span className="tc-muted">Not recorded</span>
      ) : (
        <CellStack primary={minutesAsHours(row.totalWorkedMinutes)} secondary={`${minutesAsHours(row.averageWorkedMinutes)} a day`} />
      ),
  },
  {
    key: 'exceptions',
    header: 'Exceptions',
    align: 'end',
    width: '8rem',
    render: (row) => {
      if (row.missingPunches + row.flagged === 0) return <span className="tc-muted">None</span>;
      const flagged = row.flagged > 0 ? `${count(row.flagged)} flagged` : null;
      return row.missingPunches > 0 ? (
        <CellStack
          primary={<span className="tc-cell-warn">{plural(row.missingPunches, 'missing punch', 'missing punches')}</span>}
          secondary={flagged}
        />
      ) : (
        <span className="tc-cell-warn">{flagged}</span>
      );
    },
  },
];

export function AttendanceSummaryReport({ filters, onFilters, page, onPage, lookups, onUnauthorized, onClear, narrowed }: ReportProps) {
  const query: AttendanceReportQuery = {
    from: filters.from || undefined,
    to: filters.to || undefined,
    departmentId: filters.departmentId ?? undefined,
    locationId: filters.locationId ?? undefined,
    userId: filters.employee?.id,
  };

  const result = useServerData(
    JSON.stringify(['attendance', query, page]),
    (signal) => hrReportsApi.attendance({ ...query, page, pageSize: PAGE_SIZE }, signal),
    onUnauthorized,
    'Could not load the attendance summary.',
  );

  const problem = rangeProblem(filters.from, filters.to, HR_REPORT_LIMITS.attendanceDays);

  return (
    <>
      <ReportFilterBar
        idPrefix="hr-rep-att"
        fields={{ range: { hint: `Up to ${HR_REPORT_LIMITS.attendanceDays} days, on screen and as CSV.` }, department: true, site: true, employee: true }}
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
        caption={(data) => `${plural(data.total, 'employee')} · ${calendarRange(data.from, data.to)}`}
        download={<CsvLink href={hrReportsApi.csvUrl('attendance', query)} problem={problem} />}
        empty={{
          title: 'No employees in this report',
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
            rowKey={(row) => row.userId}
            columns={COLUMNS}
            minWidth="70rem"
            caption={`Attendance summary per employee, ${calendarRange(data.from, data.to)}`}
          />
        )}
      </ReportFrame>
    </>
  );
}
