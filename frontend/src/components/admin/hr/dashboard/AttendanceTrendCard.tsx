'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DataTable, type Column } from '@/components/admin/DataTable';
import { Icon } from '@/components/ui/Icon';
import type { HrDashboardTrendPoint } from '@/lib/hrReports';
import { ApexChart, type ApexOptions } from '../../telecalling/ApexChart';
import {
  baseOptions,
  mergeChartOptions,
  tooltipHtml,
  useChartTokens,
  type ChartTokens,
} from '../../telecalling/chartTheme';
import { count } from '../reports/shared';

/**
 * The last fourteen days of attendance, one stacked column per day.
 *
 * WHAT IS COUNTED. Each active employee's day as the server's calendar classifies it —
 * the same classifier leave and payroll use — so "absent" already excludes people on
 * leave, on a holiday or on their weekly off, and a day off for everybody is an empty
 * column rather than a wall of absences.
 *
 * FOUR SERIES, NOT FIVE. Half days are drawn inside Present (they did attend) and listed
 * on their own in the tooltip and the table. A fifth colour was tried: the only token that
 * separated it from the others was the warning orange, which sits ΔE 3.9 from the danger
 * red for deuteranopia — Late and Absent would have been the pair people confused.
 *
 * THE PALETTE (dataviz validator, light surface, adjacent pairs in stacking order):
 *   Present  series1  --admin-brand   bottom, the bulk of every column
 *   Late     series2  --accent-500    brand↔accent ΔE 24.3 colour-blind
 *   On leave context  --ink-400       accent↔grey ΔE 16.0; a planned absence, de-emphasised
 *   Absent   critical --danger-600    grey↔red passes; on top, where the eye lands
 * The grey is 2.56:1 on white — deliberate, as on the telecalling charts — which is why
 * the chart has a legend, a tooltip, a visually hidden table and a Table view: colour is
 * never the only way to tell a segment apart.
 */

const HEIGHT = 280;
const PLOT_INSET_PX = 72;
const MAX_BAR_PX = 24;

const DAY_MONTH = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short' });
const WEEKDAY_DAY_MONTH = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  weekday: 'short',
  day: '2-digit',
  month: 'short',
});

/** Noon UTC on a `YYYY-MM-DD` date — that date's own parts in any browser zone. */
function noonUtc(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)) : null;
}

function axisLabel(date: string): string {
  const noon = noonUtc(date);
  return noon ? DAY_MONTH.format(noon) : date;
}

export function dayTitle(date: string): string {
  const noon = noonUtc(date);
  return noon ? WEEKDAY_DAY_MONTH.format(noon) : date;
}

/** At most 24px, never more than 70% of a column's band — bars keep air between them. */
function columnWidth(cardWidth: number, buckets: number): string {
  const band = Math.max(cardWidth - PLOT_INSET_PX, 1) / Math.max(buckets, 1);
  return band * 0.7 >= MAX_BAR_PX ? `${MAX_BAR_PX}px` : '70%';
}

/** Whole-number steps for small maxima, so an axis of 3 does not read 0, 0.5, 1 … */
function countAxis(max: number) {
  const small = max <= 5;
  return {
    min: 0,
    max: small ? Math.max(1, max) : undefined,
    tickAmount: small ? Math.max(1, max) : undefined,
    forceNiceScale: !small,
    decimalsInFloat: 0,
  };
}

function counted(point: HrDashboardTrendPoint): number {
  return point.present + point.late + point.halfDay + point.onLeave + point.absent;
}

/** A card's width, in 50px steps so dragging a window does not rebuild every frame. */
function useMeasuredWidth(): [(node: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    const measure = (value: number) => {
      if (value > 0) setWidth(Math.max(50, Math.round(value / 50) * 50));
    };
    measure(node.getBoundingClientRect().width);
    observer.current = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    observer.current.observe(node);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

type Series = { name: string; colour: (tokens: ChartTokens) => string; value: (point: HrDashboardTrendPoint) => number };

/** In stacking order: the first is the bottom segment. */
const SERIES: Series[] = [
  { name: 'Present', colour: (t) => t.series1, value: (p) => p.present + p.halfDay },
  { name: 'Late', colour: (t) => t.series2, value: (p) => p.late },
  { name: 'On leave', colour: (t) => t.context, value: (p) => p.onLeave },
  { name: 'Absent', colour: (t) => t.critical, value: (p) => p.absent },
];

function TrendPlot({ trend, tokens, width }: { trend: HrDashboardTrendPoint[]; tokens: ChartTokens; width: number }) {
  const options = useMemo<ApexOptions>(() => {
    const colours = SERIES.map((series) => series.colour(tokens));

    return mergeChartOptions(baseOptions(tokens), {
      chart: { type: 'bar', stacked: true },
      series: SERIES.map((series) => ({ name: series.name, data: trend.map(series.value) })),
      colors: colours,
      plotOptions: {
        bar: {
          horizontal: false,
          columnWidth: columnWidth(width, trend.length),
          borderRadius: 4,
          borderRadiusApplication: 'end',
          borderRadiusWhenStacked: 'last',
        },
      },
      // The 2px gap between stacked segments, in the surface colour.
      stroke: { show: true, width: 2, colors: [tokens.surface] },
      xaxis: { type: 'category', categories: trend.map((point) => axisLabel(point.date)) },
      yaxis: {
        ...countAxis(Math.max(0, ...trend.map(counted))),
        labels: { formatter: (value: number) => (Number.isFinite(value) ? count(Math.round(value)) : '') },
        title: { text: 'People', style: { color: tokens.textMuted, fontSize: '12px', fontWeight: 500 } },
      },
      tooltip: {
        shared: true,
        intersect: false,
        custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
          const point = trend[dataPointIndex];
          if (!point) return '';
          const total = counted(point);
          if (total === 0) {
            return tooltipHtml({
              title: dayTitle(point.date),
              rows: [],
              footer: 'Nobody was expected in, or nothing has been recorded yet.',
            });
          }
          return tooltipHtml({
            title: `${dayTitle(point.date)} · ${count(total)} counted`,
            rows: [
              {
                colour: colours[0],
                label: 'present',
                value: count(point.present + point.halfDay),
                note: point.halfDay > 0 ? `(incl. ${count(point.halfDay)} half day)` : undefined,
              },
              { colour: colours[1], label: 'late', value: count(point.late) },
              { colour: colours[2], label: 'on leave', value: count(point.onLeave) },
              { colour: colours[3], label: 'absent', value: count(point.absent) },
            ],
          });
        },
      },
    });
  }, [trend, tokens, width]);

  const sum = (pick: (point: HrDashboardTrendPoint) => number) => trend.reduce((total, point) => total + pick(point), 0);
  const first = trend[0];
  const last = trend[trend.length - 1];

  return (
    <ApexChart
      options={options}
      height={HEIGHT}
      label={`Attendance by day${first && last ? `, ${dayTitle(first.date)} to ${dayTitle(last.date)}` : ''}: ${count(
        sum((p) => p.present + p.halfDay),
      )} present, ${count(sum((p) => p.late))} late, ${count(sum((p) => p.onLeave))} on leave and ${count(
        sum((p) => p.absent),
      )} absent, counted in person-days. The table below the chart lists every day.`}
    />
  );
}

const COLUMNS: Column<HrDashboardTrendPoint>[] = [
  { key: 'date', header: 'Day', nowrap: true, render: (point) => dayTitle(point.date) },
  { key: 'present', header: 'Present', align: 'end', width: '6.5rem', render: (point) => count(point.present) },
  { key: 'late', header: 'Late', align: 'end', width: '5.5rem', render: (point) => count(point.late) },
  { key: 'half', header: 'Half day', align: 'end', width: '6.5rem', render: (point) => count(point.halfDay) },
  { key: 'leave', header: 'On leave', align: 'end', width: '6.5rem', render: (point) => count(point.onLeave) },
  { key: 'absent', header: 'Absent', align: 'end', width: '6rem', render: (point) => count(point.absent) },
];

export function AttendanceTrendCard({ trend, isToday }: { trend: HrDashboardTrendPoint[] | null; isToday: boolean }) {
  const titleId = useId();
  const tokens = useChartTokens();
  const [display, setDisplay] = useState<'chart' | 'table'>('chart');
  const [bodyRef, width] = useMeasuredWidth();

  const state = !trend || !tokens ? 'loading' : trend.every((point) => counted(point) === 0) ? 'empty' : 'ready';
  const rows = trend ?? [];

  return (
    <section className="tc-chart-card tc-chart-card--wide" aria-labelledby={titleId}>
      <header className="tc-chart-card__head">
        <div className="tc-chart-card__heading">
          <h3 id={titleId} className="tc-chart-card__title">
            Attendance, last 14 days
          </h3>
          <p className="tc-chart-card__sub">
            Each person&rsquo;s day as the attendance calendar classifies it, so people on leave, on a holiday or on
            their weekly off are never counted absent. Half days count as present here; the table lists them
            separately.{isToday ? ' Today shows only what has been recorded so far.' : ''}
          </p>
        </div>

        {state === 'ready' ? (
          <div className="tc-chart-card__tools">
            <div className="tc-segmented tc-segmented--sm" role="group" aria-label="Show attendance as">
              <button
                type="button"
                className="tc-segmented__button"
                aria-pressed={display === 'chart'}
                onClick={() => setDisplay('chart')}
              >
                Chart
              </button>
              <button
                type="button"
                className="tc-segmented__button"
                aria-pressed={display === 'table'}
                onClick={() => setDisplay('table')}
              >
                Table
              </button>
            </div>
          </div>
        ) : null}
      </header>

      <div className="tc-chart-card__body" ref={bodyRef} aria-busy={state === 'loading' || undefined}>
        {state === 'loading' ? (
          <div className="skeleton tc-skeleton--chart" style={{ height: HEIGHT }} aria-hidden="true" />
        ) : state === 'empty' ? (
          <div className="tc-empty tc-empty--chart" style={{ minHeight: HEIGHT }}>
            <span className="tc-empty__icon" aria-hidden="true">
              <Icon name="chart" size={22} />
            </span>
            <p className="tc-empty__title">No attendance in these fourteen days.</p>
            <p className="tc-empty__body">Days appear here once employees check in from the HR app.</p>
          </div>
        ) : display === 'table' ? (
          // Unmounted rather than hidden: the chart measures its container, and a hidden one measures zero.
          <div className="tc-chart-card__table">
            <DataTable
              rows={rows}
              rowKey={(point) => point.date}
              columns={COLUMNS}
              minWidth="36rem"
              caption="Attendance by day, last 14 days"
            />
          </div>
        ) : (
          <>
            {width > 0 && tokens ? (
              <TrendPlot trend={rows} tokens={tokens} width={width} />
            ) : (
              <div className="skeleton tc-skeleton--chart" style={{ height: HEIGHT }} aria-hidden="true" />
            )}
            {/*
              The same figures for a screen reader, without switching views. Wrapped in a
              div because a table ignores the 1px box `.sr-only` gives it, and a hidden
              table as wide as its columns widened the page on a phone.
            */}
            <div className="sr-only">
              <table>
                <caption>Attendance by day, last 14 days</caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Present</th>
                    <th scope="col">Late</th>
                    <th scope="col">Half day</th>
                    <th scope="col">On leave</th>
                    <th scope="col">Absent</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((point) => (
                    <tr key={point.date}>
                      <th scope="row">{dayTitle(point.date)}</th>
                      <td>{point.present}</td>
                      <td>{point.late}</td>
                      <td>{point.halfDay}</td>
                      <td>{point.onLeave}</td>
                      <td>{point.absent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
