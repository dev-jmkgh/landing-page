'use client';

import { CellStack, DataTable, type Column } from '@/components/admin/DataTable';
import { HR_EMPLOYMENT_STATUS_LABELS, HR_EMPLOYMENT_TYPE_LABELS, WORK_MODE_LABELS } from '@/lib/hr';
import { hrReportsApi, type EmployeeReportRow, type EmployeesReportQuery } from '@/lib/hrReports';
import { Tag } from '../../telecalling/shared';
import { ReportFrame } from './ReportFrame';
import type { ReportProps } from './reportProps';
import { ReportFilterBar } from './ReportFilterBar';
import { CsvLink, calendarDate, plural, useServerData } from './shared';

/**
 * The employee directory as a report — approved accounts only (a pending registration is
 * not yet an employee), alphabetical, with the facts HR is asked for most: department,
 * manager, joining date, employment, work mode, site and shift.
 *
 * "Not recorded" where the record has no value, rather than something adjacent: an
 * account's creation date is not a joining date.
 */

const PAGE_SIZE = 25;

function notRecorded() {
  return <span className="tc-muted">Not recorded</span>;
}

const COLUMNS: Column<EmployeeReportRow>[] = [
  {
    key: 'employee',
    header: 'Employee',
    render: (row) => (
      <CellStack primary={row.name} secondary={row.employeeCode}>
        {row.isActive ? null : <Tag tone="bad">Inactive</Tag>}
      </CellStack>
    ),
  },
  {
    key: 'contact',
    header: 'Contact',
    width: '14rem',
    render: (row) => (
      <CellStack primary={<span className="hr-rep-wrap">{row.email}</span>} secondary={row.phone ?? 'No phone recorded'} />
    ),
  },
  {
    key: 'role',
    header: 'Department',
    width: '12rem',
    render: (row) => (
      <CellStack
        primary={row.departmentName ?? notRecorded()}
        secondary={[row.designationName, row.managerName ? `Reports to ${row.managerName}` : null].filter(Boolean).join(' · ') || null}
      />
    ),
  },
  {
    key: 'joined',
    header: 'Joined',
    width: '8.5rem',
    nowrap: true,
    render: (row) => (
      <CellStack
        primary={row.joiningDate ? calendarDate(row.joiningDate) : notRecorded()}
        secondary={row.exitDate ? `Left ${calendarDate(row.exitDate)}` : null}
      />
    ),
  },
  {
    key: 'employment',
    header: 'Employment',
    width: '9rem',
    render: (row) => (
      <CellStack
        primary={HR_EMPLOYMENT_STATUS_LABELS[row.employmentStatus] ?? row.employmentStatus}
        secondary={HR_EMPLOYMENT_TYPE_LABELS[row.employmentType] ?? row.employmentType}
      />
    ),
  },
  {
    key: 'work',
    header: 'Works',
    width: '11rem',
    render: (row) => (
      <CellStack
        primary={[WORK_MODE_LABELS[row.workMode] ?? row.workMode, row.locationName].filter(Boolean).join(' · ')}
        secondary={row.shiftName ?? 'No shift'}
      />
    ),
  },
];

export function EmployeesReport({ filters, onFilters, page, onPage, lookups, onUnauthorized, onClear, narrowed }: ReportProps) {
  const query: EmployeesReportQuery = {
    departmentId: filters.departmentId ?? undefined,
    locationId: filters.locationId ?? undefined,
    employmentStatus: filters.employmentStatus || undefined,
    active: filters.active || undefined,
    q: filters.q || undefined,
  };

  const result = useServerData(
    JSON.stringify(['employees', query, page]),
    (signal) => hrReportsApi.employees({ ...query, page, pageSize: PAGE_SIZE }, signal),
    onUnauthorized,
    'Could not load the employee report.',
  );

  return (
    <>
      <ReportFilterBar
        idPrefix="hr-rep-emp"
        fields={{ department: true, site: true, employment: true, search: true }}
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
        caption={(data) => `${plural(data.total, 'employee')} with an approved account`}
        download={<CsvLink href={hrReportsApi.csvUrl('employees', query)} />}
        empty={{
          title: 'No employees match',
          message: narrowed ? 'Nobody matches these filters. Clear them to see everyone.' : 'Approved employees appear here once they exist.',
        }}
        onClear={narrowed ? onClear : undefined}
        restricted={{ title: 'Not available for your role', message: 'Your role cannot read the employee report.' }}
      >
        {(data) => (
          <DataTable
            rows={data.items}
            rowKey={(row) => row.userId}
            columns={COLUMNS}
            minWidth="68rem"
            caption="Employee directory report"
          />
        )}
      </ReportFrame>
    </>
  );
}
