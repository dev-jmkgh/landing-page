'use client';

import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  daysAgoIso,
  todayIso,
  type DateRange,
  type LeadStatus,
} from '@/lib/telecalling';

/**
 * Presentational pieces shared by the telecalling admin screens.
 *
 * Kept to the handful that genuinely appear on three or more screens. Anything used once
 * lives with the screen that uses it — an abstraction with one caller is harder to read
 * than the code it replaced.
 */

/* -------------------------------------------------------------------------- */
/* Stat tiles                                                                  */
/* -------------------------------------------------------------------------- */

export function StatCard({
  value,
  label,
  tone = 'default',
  hint,
}: {
  value: number | string;
  label: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  hint?: string;
}) {
  return (
    <div className={`tc-stat tc-stat--${tone}`}>
      <span className="tc-stat__value">{value}</span>
      <span className="tc-stat__label">{label}</span>
      {hint ? <span className="tc-stat__hint">{hint}</span> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="tc-stat-grid">{children}</div>;
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                     */
/* -------------------------------------------------------------------------- */

/** Lead status, coloured the same way on every screen. */
export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return (
    <span className={`tc-badge tc-badge--${LEAD_STATUS_TONE[status]}`}>
      {LEAD_STATUS_LABELS[status]}
    </span>
  );
}

export function Tag({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'progress' | 'good' | 'bad';
}) {
  return <span className={`tc-badge tc-badge--${tone}`}>{children}</span>;
}

/* -------------------------------------------------------------------------- */
/* Date range                                                                  */
/* -------------------------------------------------------------------------- */

export type RangePreset = 'today' | 'week' | 'month' | 'quarter' | 'all';

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'quarter', label: 'Last 90 days' },
  { key: 'all', label: 'All time' },
];

/**
 * Turns a preset into an inclusive date range.
 *
 * `all` returns an empty object rather than a very old `from`. An absent bound lets the
 * server omit the predicate entirely, which is both faster and honest — "all time" means
 * all of it, not since 1970.
 */
export function rangeFor(preset: RangePreset): DateRange {
  if (preset === 'all') return {};

  const to = todayIso();
  const days = preset === 'today' ? 0 : preset === 'week' ? 6 : preset === 'month' ? 29 : 89;

  return { from: daysAgoIso(days), to };
}

export function RangePicker({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (next: RangePreset) => void;
}) {
  return (
    <div className="tc-segmented" role="group" aria-label="Date range">
      {RANGE_PRESETS.map((preset) => (
        <button
          key={preset.key}
          type="button"
          className="tc-segmented__button"
          aria-pressed={value === preset.key}
          onClick={() => onChange(preset.key)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* States                                                                      */
/* -------------------------------------------------------------------------- */

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="table-wrap" style={{ padding: '1rem' }} aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ height: '2.75rem', marginBottom: '0.6rem' }} />
      ))}
    </div>
  );
}

/**
 * Empty state.
 *
 * Always says what to do next. "No leads" is a dead end; "No leads match these filters —
 * clear them" is something a manager can act on without guessing whether the screen is
 * broken.
 */
export function EmptyPanel({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="table-wrap">
      <div className="empty-state">
        <span className="empty-state__icon" aria-hidden="true">
          <Icon name="inbox" size={24} />
        </span>
        <p style={{ fontWeight: 600, color: 'var(--ink-700)' }}>{title}</p>
        <p>{message}</p>
        {actionLabel && onAction ? (
          <button type="button" className="btn btn--outline btn--sm" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export function Pager({
  page,
  totalPages,
  total,
  noun,
  /** Supplied when adding "s" is wrong — "entry" / "entries". */
  nounPlural,
  busy,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  noun: string;
  nounPlural?: string;
  busy?: boolean;
  onChange: (next: number) => void;
}) {
  const label = total === 1 ? noun : (nounPlural ?? `${noun}s`);

  return (
    <div className="pagination">
      <span>
        {total} {label} · page {page} of {totalPages}
      </span>
      <div className="pagination__controls">
        <button
          type="button"
          className="btn btn--outline btn--sm"
          disabled={page <= 1 || busy}
          onClick={() => onChange(Math.max(1, page - 1))}
        >
          <Icon name="arrowLeft" size={15} />
          Previous
        </button>
        <button
          type="button"
          className="btn btn--outline btn--sm"
          disabled={page >= totalPages || busy}
          onClick={() => onChange(page + 1)}
        >
          Next
          <Icon name="arrowRight" size={15} />
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Bar chart                                                                   */
/* -------------------------------------------------------------------------- */

export type BarDatum = { label: string; value: number; secondary?: number };

/**
 * A horizontal bar chart, as plain HTML.
 *
 * No charting library. Every chart this system needs is a ranked comparison of one
 * measure across a handful of categories, and that is a div with a width — which reads
 * correctly in a screen reader, prints, and adds nothing to the bundle. A static export
 * has no cheap way to bundle a chart library, and the CDN route would put a
 * render-blocking request on the marketing site's stylesheet chain too.
 *
 * `secondary` draws a second, inset bar — used for "converted, out of total".
 */
export function BarChart({
  data,
  primaryLabel,
  secondaryLabel,
  formatValue,
}: {
  data: BarDatum[];
  primaryLabel: string;
  secondaryLabel?: string;
  formatValue?: (value: number) => string;
}) {
  // Scaled against the largest bar rather than the sum, so a single dominant category
  // does not flatten everything else into invisibility.
  const max = Math.max(...data.map((datum) => datum.value), 1);
  const format = formatValue ?? ((value: number) => String(value));

  if (data.length === 0) {
    return <p className="tc-muted">Nothing to chart for this period.</p>;
  }

  return (
    <div className="tc-chart">
      <div className="tc-chart__legend">
        <span className="tc-chart__key tc-chart__key--primary">{primaryLabel}</span>
        {secondaryLabel ? (
          <span className="tc-chart__key tc-chart__key--secondary">{secondaryLabel}</span>
        ) : null}
      </div>

      <ul className="tc-chart__list">
        {data.map((datum) => (
          <li key={datum.label} className="tc-chart__row">
            <span className="tc-chart__label" title={datum.label}>
              {datum.label}
            </span>
            <span className="tc-chart__track">
              <span
                className="tc-chart__bar"
                style={{ width: `${Math.round((datum.value / max) * 100)}%` }}
              />
              {datum.secondary !== undefined ? (
                <span
                  className="tc-chart__bar tc-chart__bar--secondary"
                  style={{ width: `${Math.round((datum.secondary / max) * 100)}%` }}
                />
              ) : null}
            </span>
            <span className="tc-chart__value">
              {format(datum.value)}
              {datum.secondary !== undefined ? (
                <span className="tc-muted"> / {format(datum.secondary)}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* CSV export                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Turns rows into a CSV and hands it to the browser.
 *
 * Generated client-side from data the screen already has, rather than by a server export
 * endpoint. The rows are already loaded and already filtered, so a round trip would
 * re-run the same query to produce the same bytes — and the static host cannot generate
 * a file anyway.
 *
 * Every field is quoted and internal quotes doubled. A customer note containing a comma
 * or a newline is normal, and unquoted output would silently corrupt the column
 * alignment for every row after it.
 */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null)[][],
): void {
  const escape = (value: string | number | null): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };

  const csv = [headers.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join(
    '\r\n',
  );

  /**
   * A UTF-8 byte-order mark.
   *
   * Excel on Windows reads a BOM-less UTF-8 CSV as the system codepage, which turns
   * every non-ASCII customer name into mojibake. These exports are opened in Excel.
   */
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Released on the next tick; revoking synchronously can cancel the download in Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
