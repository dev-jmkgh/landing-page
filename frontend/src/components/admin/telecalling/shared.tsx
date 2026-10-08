'use client';

import type { MouseEvent, ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import {
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  daysAgoIso,
  formatDate,
  formatDateRange,
  formatTime,
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
  icon,
  href,
  onClick,
}: {
  value: number | string;
  label: string;
  /**
   * `accent` is the fifth tone and exists for the walked-in status, so a tile and a badge
   * describing the same thing are the same colour. See LEAD_STATUS_TONE in lib/telecalling.
   */
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'accent';
  hint?: string;
  /**
   * Optional glyph, shown above the figure.
   *
   * Optional rather than required because every existing caller omits it, and a stat
   * grid where some tiles have an icon and some do not still reads correctly — the icon
   * sits in its own row above the number rather than beside it.
   */
  icon?: IconName;
  /**
   * Makes the tile a link to the list behind its number.
   *
   * A real anchor rather than a clickable div: Tab reaches it, Enter follows it, and a
   * Ctrl- or middle-click opens the same filtered list in a new tab. Pass `onClick` too
   * to keep a plain click inside the page — `linkProps` from nav.tsx gives both.
   */
  href?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const content = (
    <>
      {icon ? (
        <span className="tc-stat__icon" aria-hidden="true">
          <Icon name={icon} size={16} />
        </span>
      ) : null}
      <span className="tc-stat__value">{value}</span>
      <span className="tc-stat__label">{label}</span>
      {hint ? <span className="tc-stat__hint">{hint}</span> : null}
    </>
  );

  if (href) {
    return (
      <a className={`tc-stat tc-stat--${tone} tc-stat--link tc-reveal`} href={href} onClick={onClick}>
        {content}
      </a>
    );
  }

  return <div className={`tc-stat tc-stat--${tone} tc-reveal`}>{content}</div>;
}

/**
 * Placeholder tiles, shaped like the stat grid they stand in for.
 *
 * The dashboard used to render nothing at all while its single request was in flight, so
 * the screen was blank and then fully populated. Showing the shape first makes the same
 * wait read as loading rather than as broken.
 */
export function StatGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="tc-stat-grid" aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton tc-skeleton--stat" />
      ))}
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
  /** `warn` is for "needs a look, not wrong": a skipped row, a SIM not set up yet. */
  tone?: 'neutral' | 'progress' | 'good' | 'warn' | 'bad';
}) {
  return <span className={`tc-badge tc-badge--${tone}`}>{children}</span>;
}

/* -------------------------------------------------------------------------- */
/* Table cells                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A date and time for a narrow table column: the IST day, with the time beneath it.
 *
 * "07 Oct 2026, 04:55 pm" on one line needs about 12.5rem and cannot wrap without
 * splitting the value, so a table with several such columns overflowed the widths it
 * declared and crushed its other columns instead — customer names and phone numbers broke
 * across lines and selects cut names short. Two short lines fit 7.5rem.
 */
export function DateTimeCell({ value, tone }: { value: string | null; tone?: 'bad' }) {
  if (!value) return <span className="tc-muted">—</span>;

  return (
    <span className={`tc-datetime${tone === 'bad' ? ' tc-cell-bad' : ''}`}>
      <span>{formatDate(value)}</span>
      <span className="tc-datetime__time">{formatTime(value)}</span>
    </span>
  );
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
  custom,
  onClearCustom,
  label = 'Date range',
}: {
  value: RangePreset;
  onChange: (next: RangePreset) => void;
  /**
   * An explicit range standing in for the preset — a chart bucket or a dashboard tile
   * opened onto exactly the days it counted — shown as a chip after the presets.
   *
   * While it is set no preset is pressed, because none is in force. Choosing a preset is
   * how a person replaces it, so a caller's `onChange` should clear it as well.
   */
  custom?: DateRange | null;
  /** Gives the chip a remove button, which should drop back to the preset. */
  onClearCustom?: () => void;
  /** The group's accessible name, for a screen with more than one date filter. */
  label?: string;
}) {
  const customText = custom && (custom.from || custom.to) ? formatDateRange(custom) : null;

  return (
    <div className="tc-segmented" role="group" aria-label={label}>
      {RANGE_PRESETS.map((preset) => (
        <button
          key={preset.key}
          type="button"
          className="tc-segmented__button"
          aria-pressed={customText === null && value === preset.key}
          onClick={() => onChange(preset.key)}
        >
          {preset.label}
        </button>
      ))}

      {customText !== null ? (
        <span className="tc-segmented__chip">
          <span className="sr-only">Showing </span>
          {customText}
          {onClearCustom ? (
            <button
              type="button"
              className="tc-segmented__clear"
              onClick={onClearCustom}
              aria-label={`Remove the range ${customText}`}
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </span>
      ) : null}
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
 * For ranked comparisons of one measure across a handful of categories, which is what
 * Reports shows: a div with a width reads correctly in a screen reader, prints, and adds
 * nothing to the bundle. Keep using it for those.
 *
 * The dashboard's trend charts are the exception. A time axis, stacked segments and a
 * donut are not a div with a width, so they use ApexCharts, through a wrapper that loads
 * the library with a dynamic `import()` only when a chart is on screen — never in this
 * route's main bundle, and never during the static export, where the library cannot run.
 * A CDN script is still not the answer: it would put a render-blocking request on the
 * marketing site's stylesheet chain.
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
 *
 * Text that starts with = + - @, a tab or a carriage return gets a leading apostrophe.
 * Excel strips the quotes and still runs such a cell as a formula, and notes and names
 * are typed by employees and customers — `=HYPERLINK(...)` in a call note would send the
 * neighbouring phone numbers to whoever wrote it. The same rule as the API's own CSV
 * (`csvCell` in the lead import). Numbers stay numbers.
 */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null)[][],
): void {
  const escape = (value: string | number | null): string => {
    const text = value === null || value === undefined ? '' : String(value);
    const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
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
