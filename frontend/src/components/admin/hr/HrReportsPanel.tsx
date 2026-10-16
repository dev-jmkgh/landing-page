'use client';

import { useCallback, useState, type KeyboardEvent } from 'react';
import { HR_EMPLOYMENT_STATUSES, type HrEmploymentStatus } from '@/lib/hr';
import { AttendanceSummaryReport } from './reports/AttendanceSummaryReport';
import { DailyAttendanceReport } from './reports/DailyAttendanceReport';
import { EmployeesReport } from './reports/EmployeesReport';
import { useLookups } from './reports/filters';
import { LeaveReport } from './reports/LeaveReport';
import { PayrollReport } from './reports/PayrollReport';
import type { ReportFilters } from './reports/ReportFilterBar';
import type { ReportProps } from './reports/reportProps';
import {
  companyToday,
  monthStart,
  readUrlDate,
  readUrlEnum,
  readUrlId,
  readUrlPage,
  readUrlParam,
  useUrlParams,
} from './reports/shared';

/**
 * HR reports: attendance (a summary per person and day by day), leave, the employee
 * directory and payroll by year.
 *
 * Every table is the server's page of the report — nothing is gathered in the browser —
 * and every "Download CSV" asks the server for the same report with the same filters as
 * a file, which it streams in full (bounded by the validated range) and records in the
 * HR audit trail.
 *
 * The report, its filters and the page live in the address, so a refresh, a pasted link
 * or Back from another section reopens exactly the same report. The date range opens on
 * the current month so far, the server's own default.
 */

const TABS = ['attendance', 'daily', 'leave', 'employees', 'payroll'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  attendance: 'Attendance summary',
  daily: 'Daily attendance',
  leave: 'Leave',
  employees: 'Employees',
  payroll: 'Payroll',
};

function readYear(fallback: number): number {
  const year = readUrlId('report-year');
  return year !== null && year >= 2000 && year <= 2100 ? year : fallback;
}

/** Which filters narrow each report beyond its defaults — what "Clear filters" undoes. */
function isNarrowed(tab: Tab, filters: ReportFilters): boolean {
  switch (tab) {
    case 'attendance':
    case 'daily':
      return filters.departmentId !== null || filters.locationId !== null || filters.employee !== null;
    case 'leave':
      return filters.departmentId !== null || filters.employee !== null;
    case 'employees':
      return (
        filters.departmentId !== null ||
        filters.locationId !== null ||
        filters.employmentStatus !== '' ||
        filters.active !== '' ||
        filters.q !== ''
      );
    case 'payroll':
      return false;
  }
}

export function HrReportsPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  // The defaults, fixed for the life of the screen: one left open past midnight keeps the
  // range it showed rather than moving under the reader.
  const [defaults] = useState(() => {
    const today = companyToday();
    return { from: monthStart(today), to: today, year: Number(today.slice(0, 4)) };
  });

  const [tab, setTab] = useState<Tab>(() => readUrlEnum('report', TABS, 'attendance'));
  const [page, setPage] = useState(() => readUrlPage('report-page'));
  const [filters, setFilters] = useState<ReportFilters>(() => {
    const employeeId = readUrlId('report-emp');
    return {
      from: readUrlDate('report-from') || defaults.from,
      to: readUrlDate('report-to') || defaults.to,
      departmentId: readUrlId('report-dept'),
      locationId: readUrlId('report-site'),
      employee: employeeId === null ? null : { id: employeeId, name: null, code: null },
      year: readYear(defaults.year),
      employmentStatus: readUrlEnum<HrEmploymentStatus | ''>('report-status', HR_EMPLOYMENT_STATUSES, ''),
      active: readUrlEnum<'' | 'true' | 'false'>('report-active', ['true', 'false'], ''),
      q: (readUrlParam('report-q') ?? '').trim().slice(0, 120),
    };
  });

  useUrlParams({
    report: tab === 'attendance' ? null : tab,
    'report-from': filters.from === defaults.from ? null : filters.from,
    'report-to': filters.to === defaults.to ? null : filters.to,
    'report-dept': filters.departmentId === null ? null : String(filters.departmentId),
    'report-site': filters.locationId === null ? null : String(filters.locationId),
    'report-emp': filters.employee === null ? null : String(filters.employee.id),
    'report-year': filters.year === defaults.year ? null : String(filters.year),
    'report-status': filters.employmentStatus || null,
    'report-active': filters.active || null,
    'report-q': filters.q || null,
    'report-page': page > 1 ? String(page) : null,
  });

  const lookups = useLookups(onUnauthorized);

  // A filter change starts the report from its first page, in the handler that makes it.
  const onFilters = useCallback((patch: Partial<ReportFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }, []);

  const onClear = useCallback(() => {
    setFilters((current) => ({
      ...current,
      departmentId: null,
      locationId: null,
      employee: null,
      employmentStatus: '',
      active: '',
      q: '',
    }));
    setPage(1);
  }, []);

  const chooseTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setPage(1);
  };

  // Arrow keys move between tabs, as the tab pattern expects; Tab moves on into the report.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + step + TABS.length) % TABS.length;
    const next = TABS[nextIndex] ?? tab;
    chooseTab(next);
    document.getElementById(`hr-rep-tab-${next}`)?.focus();
  };

  const props: ReportProps = {
    filters,
    onFilters,
    page,
    onPage: setPage,
    lookups,
    onUnauthorized,
    onClear,
    narrowed: isNarrowed(tab, filters),
  };

  return (
    <>
      <div className="admin-toolbar">
        <div className="admin-tabs hr-rep-tabs" role="tablist" aria-label="Report">
          {TABS.map((option) => (
            <button
              key={option}
              id={`hr-rep-tab-${option}`}
              type="button"
              role="tab"
              className="admin-tab"
              aria-selected={tab === option}
              aria-controls="hr-rep-panel"
              tabIndex={tab === option ? 0 : -1}
              onClick={() => chooseTab(option)}
              onKeyDown={onTabKey}
            >
              {TAB_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      <div id="hr-rep-panel" role="tabpanel" aria-labelledby={`hr-rep-tab-${tab}`}>
        {tab === 'attendance' ? <AttendanceSummaryReport {...props} /> : null}
        {tab === 'daily' ? <DailyAttendanceReport {...props} /> : null}
        {tab === 'leave' ? <LeaveReport {...props} /> : null}
        {tab === 'employees' ? <EmployeesReport {...props} /> : null}
        {tab === 'payroll' ? <PayrollReport {...props} /> : null}
      </div>
    </>
  );
}
