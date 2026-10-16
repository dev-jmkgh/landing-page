'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HR_EMPLOYMENT_STATUSES, HR_EMPLOYMENT_STATUS_LABELS, type HrEmploymentStatus } from '@/lib/hr';
import { EmployeePicker, type PickedEmployee } from './EmployeePicker';
import { DateRangeFields, DepartmentSelect, SiteSelect, YearSelect, type Lookups } from './filters';

/**
 * The filters of every report, held once by the Reports section.
 *
 * One set rather than one per tab: moving from the summary to the day-by-day report keeps
 * the range, department and person, which is nearly always what the reader wants next.
 * Each tab shows only the filters its endpoint takes, and sends only those.
 */
export type ReportFilters = {
  /** `YYYY-MM-DD`; blank leaves it to the server (the current month so far). */
  from: string;
  to: string;
  departmentId: number | null;
  /** The employee's ASSIGNED site. */
  locationId: number | null;
  employee: PickedEmployee | null;
  year: number;
  employmentStatus: HrEmploymentStatus | '';
  active: '' | 'true' | 'false';
  q: string;
};

export type FilterFields = {
  range?: { hint: string };
  department?: boolean;
  site?: boolean;
  employee?: boolean;
  years?: number[];
  employment?: boolean;
  search?: boolean;
};

/** A search box that commits after a pause, so a request is not fired per keystroke. */
function SearchField({ id, value, onCommit }: { id: string; value: string; onCommit: (next: string) => void }) {
  const [text, setText] = useState(value);
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  });

  // A value changed from outside (Clear filters) replaces whatever was typed.
  useEffect(() => {
    setText((current) => (current.trim() === value ? current : value));
  }, [value]);

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === value) return;
    const timer = window.setTimeout(() => commitRef.current(trimmed), 350);
    return () => window.clearTimeout(timer);
  }, [text, value]);

  return (
    <div className="field hr-rep-field--search">
      <label className="field__label" htmlFor={id}>
        Search
      </label>
      <input
        id={id}
        className="input"
        type="search"
        placeholder="Name, email or code"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  );
}

export function ReportFilterBar({
  idPrefix,
  fields,
  filters,
  onChange,
  lookups,
  errors,
  onUnauthorized,
  actions,
}: {
  idPrefix: string;
  fields: FilterFields;
  filters: ReportFilters;
  onChange: (patch: Partial<ReportFilters>) => void;
  lookups: Lookups;
  errors?: Record<string, string>;
  onUnauthorized: () => void;
  /** Buttons for the end of the bar, e.g. Clear filters. */
  actions?: ReactNode;
}) {
  return (
    <div className="admin-toolbar hr-rep-toolbar">
      <div className="admin-filters">
        {fields.range ? (
          <DateRangeFields
            idPrefix={idPrefix}
            from={filters.from}
            to={filters.to}
            onChange={(range) => onChange(range)}
            errors={errors}
            hint={fields.range.hint}
          />
        ) : null}

        {fields.years ? (
          <YearSelect
            id={`${idPrefix}-year`}
            value={filters.year}
            onChange={(year) => onChange({ year })}
            years={fields.years}
          />
        ) : null}

        {fields.department ? (
          <DepartmentSelect
            id={`${idPrefix}-department`}
            value={filters.departmentId}
            onChange={(departmentId) => onChange({ departmentId })}
            departments={lookups.departments}
          />
        ) : null}

        {fields.site ? (
          <SiteSelect
            id={`${idPrefix}-site`}
            value={filters.locationId}
            onChange={(locationId) => onChange({ locationId })}
            locations={lookups.locations}
          />
        ) : null}

        {fields.employment ? (
          <>
            <div className="field hr-rep-field--select">
              <label className="field__label" htmlFor={`${idPrefix}-status`}>
                Employment status
              </label>
              <select
                id={`${idPrefix}-status`}
                className="select"
                value={filters.employmentStatus}
                onChange={(event) =>
                  onChange({ employmentStatus: event.target.value as ReportFilters['employmentStatus'] })
                }
              >
                <option value="">Any status</option>
                {HR_EMPLOYMENT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {HR_EMPLOYMENT_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field hr-rep-field--select">
              <label className="field__label" htmlFor={`${idPrefix}-active`}>
                Account
              </label>
              <select
                id={`${idPrefix}-active`}
                className="select"
                value={filters.active}
                onChange={(event) => onChange({ active: event.target.value as ReportFilters['active'] })}
              >
                <option value="">Active and inactive</option>
                <option value="true">Active only</option>
                <option value="false">Inactive only</option>
              </select>
            </div>
          </>
        ) : null}

        {fields.employee ? (
          <EmployeePicker
            id={`${idPrefix}-employee`}
            value={filters.employee}
            onChange={(employee) => onChange({ employee })}
            onUnauthorized={onUnauthorized}
          />
        ) : null}

        {fields.search ? (
          <SearchField id={`${idPrefix}-search`} value={filters.q} onCommit={(q) => onChange({ q })} />
        ) : null}

        {actions}
      </div>

      {fields.range ? <p className="hr-rep-toolbar__hint">{fields.range.hint}</p> : null}
    </div>
  );
}
