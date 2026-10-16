'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { attendanceAdminApi, peopleApi, type Department, type WorkLocation } from '@/lib/hr';
import { isAbort } from './shared';

/**
 * The filter controls the HR reports share.
 *
 * Every control is a real labelled form field. A server refusal for a field (a range
 * that is too long, a start after the end) is shown under that field as well as in the
 * banner, so the reader knows which input to change.
 */

/* -------------------------------------------------------------------------- */
/* Departments and sites                                                       */
/* -------------------------------------------------------------------------- */

export type Lookups = {
  departments: Department[] | null;
  locations: WorkLocation[] | null;
  /** True once either list failed; the filter then offers "All" only, which still works. */
  failed: boolean;
};

/**
 * The department and site lists, loaded once for the section.
 *
 * Both are small bounded lists. A failure is quiet — the filter shows only "All", which
 * is still a correct report — rather than a banner over a screen that otherwise works.
 */
export function useLookups(onUnauthorized: () => void): Lookups {
  const [state, setState] = useState<Lookups>({ departments: null, locations: null, failed: false });
  const unauthorizedRef = useRef(onUnauthorized);
  useEffect(() => {
    unauthorizedRef.current = onUnauthorized;
  });

  useEffect(() => {
    const controller = new AbortController();
    const quietly = <T,>(promise: Promise<T>) =>
      promise.catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) unauthorizedRef.current();
        if (!isAbort(caught)) setState((previous) => ({ ...previous, failed: true }));
        return null;
      });

    void quietly(peopleApi.listDepartments(controller.signal)).then((departments) => {
      if (departments && !controller.signal.aborted) setState((previous) => ({ ...previous, departments }));
    });
    void quietly(attendanceAdminApi.listLocations(controller.signal)).then((locations) => {
      if (locations && !controller.signal.aborted) setState((previous) => ({ ...previous, locations }));
    });

    return () => controller.abort();
  }, []);

  return state;
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Not a live region: the banner above the report already announces the same refusal, and
 * the input points here with `aria-describedby`, so it is read again when focused.
 */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <span id={id} className="field__error">
      {message}
    </span>
  );
}

export function DateRangeFields({
  idPrefix,
  from,
  to,
  onChange,
  errors,
  hint,
}: {
  idPrefix: string;
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
  errors?: Record<string, string>;
  /** Shown under the pair, e.g. "Up to 93 days." */
  hint?: string;
}) {
  const fromError = errors?.from;
  const toError = errors?.to;

  return (
    <fieldset className="hr-rep-range">
      <legend className="sr-only">Date range{hint ? `. ${hint}` : ''}</legend>
      <div className={fromError ? 'field field--invalid hr-rep-field--date' : 'field hr-rep-field--date'}>
        <label className="field__label" htmlFor={`${idPrefix}-from`}>
          From
        </label>
        <input
          id={`${idPrefix}-from`}
          className="input"
          type="date"
          value={from}
          max={to || undefined}
          aria-invalid={fromError ? true : undefined}
          aria-describedby={fromError ? `${idPrefix}-from-error` : undefined}
          onChange={(event) => onChange({ from: event.target.value, to })}
        />
        <FieldError id={`${idPrefix}-from-error`} message={fromError} />
      </div>
      <div className={toError ? 'field field--invalid hr-rep-field--date' : 'field hr-rep-field--date'}>
        <label className="field__label" htmlFor={`${idPrefix}-to`}>
          To
        </label>
        <input
          id={`${idPrefix}-to`}
          className="input"
          type="date"
          value={to}
          min={from || undefined}
          aria-invalid={toError ? true : undefined}
          aria-describedby={toError ? `${idPrefix}-to-error` : undefined}
          onChange={(event) => onChange({ from, to: event.target.value })}
        />
        <FieldError id={`${idPrefix}-to-error`} message={toError} />
      </div>
    </fieldset>
  );
}

export function DepartmentSelect({
  id,
  value,
  onChange,
  departments,
}: {
  id: string;
  value: number | null;
  onChange: (next: number | null) => void;
  departments: Department[] | null;
}) {
  return (
    <div className="field hr-rep-field--select">
      <label className="field__label" htmlFor={id}>
        Department
      </label>
      <select
        id={id}
        className="select"
        value={value === null ? '' : String(value)}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">All departments</option>
        {/* A department from the address that the list has not loaded yet still shows as chosen. */}
        {value !== null && !departments?.some((department) => department.id === value) ? (
          <option value={String(value)}>Department #{value}</option>
        ) : null}
        {(departments ?? []).map((department) => (
          <option key={department.id} value={String(department.id)}>
            {department.name}
            {department.isActive ? '' : ' (inactive)'}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SiteSelect({
  id,
  value,
  onChange,
  locations,
}: {
  id: string;
  value: number | null;
  onChange: (next: number | null) => void;
  locations: WorkLocation[] | null;
}) {
  return (
    <div className="field hr-rep-field--select">
      <label className="field__label" htmlFor={id}>
        Assigned site
      </label>
      <select
        id={id}
        className="select"
        value={value === null ? '' : String(value)}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">All sites</option>
        {value !== null && !locations?.some((location) => location.id === value) ? (
          <option value={String(value)}>Site #{value}</option>
        ) : null}
        {(locations ?? []).map((location) => (
          <option key={location.id} value={String(location.id)}>
            {location.name}
            {location.isActive ? '' : ' (inactive)'}
          </option>
        ))}
      </select>
    </div>
  );
}

export function YearSelect({
  id,
  value,
  onChange,
  years,
}: {
  id: string;
  value: number;
  onChange: (next: number) => void;
  years: number[];
}) {
  const options = years.includes(value) ? years : [value, ...years].sort((a, b) => b - a);

  return (
    <div className="field hr-rep-field--year">
      <label className="field__label" htmlFor={id}>
        Year
      </label>
      <select id={id} className="select" value={String(value)} onChange={(event) => onChange(Number(event.target.value))}>
        {options.map((year) => (
          <option key={year} value={String(year)}>
            {year}
          </option>
        ))}
      </select>
    </div>
  );
}

/** `from` down to `from - back`, newest first. */
export function yearsBack(from: number, back: number): number[] {
  return Array.from({ length: back + 1 }, (_, index) => from - index);
}
