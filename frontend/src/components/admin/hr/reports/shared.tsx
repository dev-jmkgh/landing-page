'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ApiError, isApiConfigured, type FieldErrors } from '@/lib/api';
import { isIsoDate, todayIso } from '@/lib/telecalling';

/**
 * Pieces shared by the HR Dashboard, Reports and Audit log sections.
 *
 * Kept beside the reports because that is where most of it is used; the dashboard and the
 * audit trail import from here rather than growing a copy each.
 */

export function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

/* -------------------------------------------------------------------------- */
/* One server read                                                             */
/* -------------------------------------------------------------------------- */

export type ServerData<T> = {
  /** The last answer. Kept while a new request is in flight, so a refetch dims rather than blanks. */
  data: T | null;
  loading: boolean;
  error: string | null;
  /** HTTP status of the failure — 403 is a role gate, 400 a refused filter. */
  status: number | null;
  fieldErrors: FieldErrors;
  reload: () => void;
};

type State<T> = {
  data: T | null;
  /** The request `data` answered. */
  dataKey: string | null;
  loading: boolean;
  error: string | null;
  status: number | null;
  fieldErrors: FieldErrors;
};

/**
 * Loads whatever `key` names, again whenever it changes, and aborts the request it
 * replaces.
 *
 * `key` is the request's identity (its URL, in practice): every filter that changes the
 * answer must change the key. Null means "not now" — nothing is fetched.
 *
 * A failure keeps the previous answer only if it was for the same key — a refresh that
 * failed. Rows for other filters under a heading for these ones would be a wrong answer
 * presented as a right one, so a refused filter shows its message and no table.
 */
export function useServerData<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  onUnauthorized: () => void,
  fallbackMessage: string,
): ServerData<T> {
  const [state, setState] = useState<State<T>>({
    data: null,
    dataKey: null,
    loading: key !== null,
    error: null,
    status: null,
    fieldErrors: {},
  });
  const [attempt, setAttempt] = useState(0);

  // The newest closures, read by the effect without making them its dependencies — the
  // key alone decides when to fetch.
  const fetcherRef = useRef(fetcher);
  const unauthorizedRef = useRef(onUnauthorized);
  useEffect(() => {
    fetcherRef.current = fetcher;
    unauthorizedRef.current = onUnauthorized;
  });

  useEffect(() => {
    if (key === null) {
      setState((previous) => ({ ...previous, loading: false }));
      return;
    }

    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true, error: null, status: null, fieldErrors: {} }));

    fetcherRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ data, dataKey: key, loading: false, error: null, status: null, fieldErrors: {} });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || isAbort(caught)) return;
        if (caught instanceof ApiError && caught.status === 401) {
          unauthorizedRef.current();
          return;
        }
        setState((previous) => ({
          data: previous.dataKey === key ? previous.data : null,
          dataKey: previous.dataKey === key ? previous.dataKey : null,
          loading: false,
          error: caught instanceof ApiError ? caught.message : fallbackMessage,
          status: caught instanceof ApiError ? caught.status : null,
          fieldErrors: caught instanceof ApiError ? caught.fieldErrors : {},
        }));
      });

    return () => controller.abort();
  }, [key, attempt, fallbackMessage]);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    status: state.status,
    fieldErrors: state.fieldErrors,
    reload: () => setAttempt((value) => value + 1),
  };
}

/* -------------------------------------------------------------------------- */
/* The address                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The section's view, kept in the address with `replaceState`.
 *
 * `HrApp` owns `?section=` and pushes one history entry per section; inside a section
 * these screens only REPLACE, so a filter change never adds a Back step, but a refresh,
 * a pasted link or Back from another section reopens the same report.
 *
 * Each parameter is removed again when the section unmounts, and every name is
 * namespaced (`report-from`, `audit-page`, `dash-date`). Both are needed: HrApp builds
 * the next section's address from the current one, and the next panel reads its initial
 * state during render — BEFORE this section's unmount cleanup runs — so a plain `from` or
 * `page` written here would be read by, say, the Leave screen as its own filter. The
 * history entry this section was on keeps its parameters, which is what makes Back work.
 */
export function readUrlParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

function writeUrlParams(values: Record<string, string | null>): void {
  const url = new URL(window.location.href);
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === '') url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  if (url.href !== window.location.href) {
    // HrApp's entries carry `{ section }`; keep it.
    window.history.replaceState(window.history.state, '', url);
  }
}

/** Writes `values` to the address while mounted, and takes them out again on unmount. */
export function useUrlParams(values: Record<string, string | null>): void {
  const serialised = JSON.stringify(values);

  useEffect(() => {
    writeUrlParams(JSON.parse(serialised) as Record<string, string | null>);
  }, [serialised]);

  const names = Object.keys(values).sort().join(',');
  useEffect(
    () => () => {
      writeUrlParams(Object.fromEntries(names.split(',').map((name) => [name, null])));
    },
    [names],
  );
}

export function readUrlEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = readUrlParam(name);
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A positive whole number from the address, or null. */
export function readUrlId(name: string): number | null {
  const value = readUrlParam(name);
  if (value === null || !/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

export function readUrlDate(name: string): string {
  const value = readUrlParam(name);
  return value !== null && isIsoDate(value) ? value : '';
}

export function readUrlPage(name = 'page'): number {
  return readUrlId(name) ?? 1;
}

/* -------------------------------------------------------------------------- */
/* Company-calendar dates                                                      */
/* -------------------------------------------------------------------------- */

/** Today in the company calendar (IST), whatever zone the browser is in. */
export function companyToday(): string {
  return todayIso();
}

const CALENDAR_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

/**
 * A `YYYY-MM-DD` calendar date in words, "01 Apr 2021".
 *
 * Formatted from noon UTC in UTC, so the date is that date in any browser zone — a joining
 * date is a fact about a day, not an instant, and must never move to the day before.
 */
export function calendarDate(date: string | null): string {
  if (!date) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return CALENDAR_DATE.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)));
}

const CALENDAR_DAY = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

/**
 * "Fri, 16 Oct 2026" — a calendar date with its weekday, zone-proof like `calendarDate`.
 * Assembled from parts: `en-IN` puts a comma before the year when a weekday is present.
 */
export function calendarDay(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  const noon = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  for (const part of CALENDAR_DAY.formatToParts(noon)) parts[part.type] = part.value;
  return `${parts.weekday ?? ''}, ${parts.day ?? ''} ${parts.month ?? ''} ${parts.year ?? ''}`.trim();
}

/** "1–16 Oct 2026" for an inclusive range of calendar dates. */
export function calendarRange(from: string, to: string): string {
  if (from === to) return calendarDate(from);
  const [a, b] = [calendarDate(from), calendarDate(to)];
  const [aDay, aMonth, aYear] = a.split(' ');
  const [, bMonth, bYear] = b.split(' ');
  if (aYear === bYear && aMonth === bMonth) return `${aDay}–${b}`;
  if (aYear === bYear) return `${aDay} ${aMonth} – ${b}`;
  return `${a} – ${b}`;
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Days in an inclusive range, counting both ends. */
export function daysInclusive(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * Why a range would be refused, in the server's own words, or null when it would not.
 *
 * Used only to decide whether a CSV link can be offered: a link that the server refuses
 * opens a tab holding an error. The table always asks the server and shows its answer.
 */
export function rangeProblem(from: string, to: string, maxDays: number): string | null {
  const end = to || companyToday();
  const start = from || monthStart(end);
  if (!isIsoDate(start) || !isIsoDate(end)) return 'Enter real dates for the range.';
  if (start > end) return 'The start date must be on or before the end date.';
  const days = daysInclusive(start, end);
  if (days > maxDays) return `Choose a range of ${maxDays} days or fewer. This one covers ${days} days.`;
  return null;
}

/* -------------------------------------------------------------------------- */
/* States                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a role that may not see this gets.
 *
 * Calm on purpose. A supervisor opening the payroll report or the audit trail has not
 * hit a fault, and an error banner with "Try again" would invite them to keep trying
 * something no retry can change.
 */
export function RestrictedPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="table-wrap">
      <div className="empty-state" role="status">
        <span className="empty-state__icon" aria-hidden="true">
          <Icon name="shield" size={24} />
        </span>
        <p style={{ fontWeight: 600, color: 'var(--ink-700)' }}>{title}</p>
        <p>{message}</p>
      </div>
    </div>
  );
}

/**
 * "Download CSV" for a report — a plain link carrying the admin session cookie, like the
 * telecalling import template.
 *
 * The server builds the file from the same filters as the table, every row of them, and
 * sends it as an attachment, so the new tab closes itself once the download starts. It
 * opens in a new tab so that a refusal (a session that ended) shows there rather than
 * replacing this screen. When the range is one the server would refuse, the button is
 * disabled with the reason beside it instead.
 */
export function CsvLink({ href, problem, label = 'Download CSV' }: { href: string; problem?: string | null; label?: string }) {
  const hintId = useId();

  // A frontend-only deployment has no API to build the file.
  if (!isApiConfigured()) return null;

  if (problem) {
    return (
      <span className="hr-rep-csv">
        <button type="button" className="btn btn--outline btn--sm" disabled aria-describedby={hintId}>
          <Icon name="download" size={15} />
          {label}
        </button>
        <span id={hintId} className="hr-rep-csv__hint">
          {problem}
        </span>
      </span>
    );
  }

  return (
    <a className="btn btn--outline btn--sm" href={href} target="_blank" rel="noopener">
      <Icon name="download" size={15} />
      {label}
    </a>
  );
}

/** A heading row over a report: what it covers on the left, the download on the right. */
export function ResultsHead({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="hr-rep-head">
      <p className="hr-rep-head__caption">{children}</p>
      {actions ? <div className="hr-rep-head__actions">{actions}</div> : null}
    </div>
  );
}

/** A count with Indian digit grouping. */
export function count(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-IN') : '—';
}

export function plural(value: number, one: string, many = `${one}s`): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}
