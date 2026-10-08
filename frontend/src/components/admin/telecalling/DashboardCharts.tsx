'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { DataTable, type Column } from '@/components/admin/DataTable';
import { LoadingOverlay } from '@/components/admin/Loader';
import { FormAlert } from '@/components/forms/Fields';
import { Icon } from '@/components/ui/Icon';
import {
  LEAD_STATUS_LABELS,
  formatBucketTitle,
  formatClock,
  formatCount,
  formatDateRange,
  formatDuration,
  type AnalyticsFrame,
  type AnalyticsGranularity,
  type CallBucket,
  type DashboardAnalytics,
  type DateRange,
  type EmployeePerformance,
  type FollowUpScope,
  type LeadBucket,
  type LeadStatus,
} from '@/lib/telecalling';
import { ApexChart, type ApexOptions, type ChartHit } from './ApexChart';
import {
  baseOptions,
  escapeHtml,
  mergeChartOptions,
  tooltipHtml,
  useChartTokens,
  type ChartTokens,
  type TooltipRow,
} from './chartTheme';
import { NavLink, useTelecallingNav } from './nav';
import type { RangePreset } from './shared';
import type { Section, UrlParams } from './urlState';

/**
 * The dashboard's trend charts (C1–C6): calls, talk time, follow-ups due, leads by status,
 * new leads and conversions, and the busiest telecallers.
 *
 * Every chart obeys three rules, because a chart that breaks one of them is worse than the
 * tiles it sits under:
 *
 * - **It counts what the list it opens counts.** A click opens the section whose filters
 *   select exactly the rows the mark stands for — same dates (bucket dates come from the
 *   server, already clamped to the range), same outcome or status. Where no list filter
 *   can express a mark (an hour of a day, a cancelled follow-up, conversions of archived
 *   leads) the mark is not clickable at all, rather than opening a list that disagrees.
 *
 * - **It never gates a value behind the pointer.** Every chart has a table view with the
 *   same figures, and each row of it has the link a click on the chart would follow — the
 *   way in for a keyboard or a screen reader.
 *
 * - **It shows nothing rather than an empty frame.** A period with no data gets a
 *   sentence saying so, not a pair of empty axes.
 */

type Destination = { section: Section; params: UrlParams };

/* -------------------------------------------------------------------------- */
/* Destinations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How the calls list spells "All time" in its address (CallsPanel's own `range` value).
 *
 * Not `all`: urlState never writes `all`, which every filter select uses for "no filter",
 * so the calls list would fall back to its default of the last seven days.
 */
const CALLS_ALL_TIME = 'all-time';

/**
 * The leads list's filters for a dashboard preset — the window the lead tiles counted.
 *
 * "All time" sends nothing: it is the leads list's own default, and the address could not
 * say it anyway (urlState never writes `all`, which every filter uses for "no filter").
 */
export function leadsWindow(preset: RangePreset): UrlParams {
  return preset === 'all' ? {} : { range: preset };
}

/**
 * The calls list's filters for a dashboard preset — the window the call tiles counted.
 *
 * Always explicit: the calls list opens on the last seven days, so leaving the range out
 * would open the wrong window. "All time" is the list's own unbounded preset, the same
 * no-date-filter predicate the tiles used.
 */
export function callsWindow(preset: RangePreset): UrlParams {
  return { range: preset === 'all' ? CALLS_ALL_TIME : preset };
}

/** The calls in one bucket, optionally narrowed to an outcome or a direction. */
function callsInBucket(frame: AnalyticsFrame, narrow: UrlParams = {}): Destination {
  return { section: 'calls', params: { from: frame.from, to: frame.to, ...narrow } };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** Talk time for a chart: like the tiles, except that nothing reads "0m" rather than "—". */
function talkTime(seconds: number): string {
  return seconds > 0 ? formatDuration(seconds) : '0m';
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

const DAY_MONTH = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short' });
const MONTH_YEAR = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', month: 'short', year: '2-digit' });

/** Noon UTC on a `YYYY-MM-DD` date: that date's own calendar parts, in any browser zone. */
function noonUtc(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
}

/**
 * A bucket's label on the axis: "09:00", "06 Oct", the first day of a week "29 Sep", or
 * "Oct '26".
 *
 * Built from the bucket's own strings and formatted in UTC, so the axis never moves with
 * the browser's time zone — the buckets are IST days whoever is looking.
 */
function axisLabel(frame: AnalyticsFrame, granularity: AnalyticsGranularity): string {
  if (granularity === 'hour') {
    const hour = /T(\d{2}):/.exec(frame.bucket)?.[1];
    return hour ? `${hour}:00` : frame.bucket;
  }

  const date = noonUtc(granularity === 'week' ? frame.from : frame.bucket);
  if (!date) return frame.bucket;

  if (granularity === 'month') {
    const parts = MONTH_YEAR.formatToParts(date);
    const month = parts.find((part) => part.type === 'month')?.value ?? '';
    const year = parts.find((part) => part.type === 'year')?.value ?? '';
    return `${month} '${year}`;
  }

  return DAY_MONTH.format(date);
}

/** A bucket's full title, for a tooltip or a table row. An hour gets its day when the chart spans two. */
function bucketTitle(frame: AnalyticsFrame, granularity: AnalyticsGranularity, multiDay: boolean): string {
  const title = formatBucketTitle(frame, granularity);
  if (granularity !== 'hour' || !multiDay) return title;
  return `${formatBucketTitle({ bucket: frame.from, from: frame.from, to: frame.to }, 'day')}, ${title}`;
}

/** Room the value axis and the plot padding take out of a card's width, roughly. */
const PLOT_INSET_PX = 72;
/** The thickest a bar may be drawn. Wider reads as a block rather than a mark. */
const MAX_BAR_PX = 24;

/**
 * Column width for `buckets` columns across a card `cardWidth` pixels wide.
 *
 * At most 24px, and never more than 70% of a column's band, so neighbouring bars always
 * keep air between them. A fixed percentage would draw 45px slabs on the wide card with a
 * week of data and slivers on a narrow one with a quarter.
 */
function columnWidth(cardWidth: number, buckets: number): string {
  const band = Math.max(cardWidth - PLOT_INSET_PX, 1) / Math.max(buckets, 1);
  return band * 0.7 >= MAX_BAR_PX ? `${MAX_BAR_PX}px` : '70%';
}

/** Room one category label takes under a chart, gap included ("08 Sept", "Sept 2026"). */
const LABEL_SLOT_PX = 72;

/**
 * How many tick intervals a line or mixed chart's category axis gets, so its labels never
 * run into each other — undefined when every label fits.
 *
 * Bar charts thin their own labels (`hideOverlappingLabels` in the base options), but the
 * library does not do it for a line or area series over categories: thirty daily labels on
 * a half-width card ran together as "12 Sept15 Sept18 Sept".
 */
function lineTickAmount(cardWidth: number, buckets: number): number | undefined {
  if (cardWidth <= 0) return undefined;
  const fits = Math.max(2, Math.floor((cardWidth - PLOT_INSET_PX) / LABEL_SLOT_PX));
  return buckets > fits ? fits - 1 : undefined;
}

/**
 * The value axis for a count. Small maxima get whole-number steps (0, 1, 2, 3) — the
 * library's nice scale would otherwise label a maximum of 3 as 0, 0.5, 1 … and round
 * those to duplicates.
 */
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

/** A count on an axis, with Indian digit grouping. */
function countLabel(value: number | string): string {
  const number = Number(value);
  return Number.isFinite(number) ? formatCount(Math.round(number)) : '';
}

/** Talk time is drawn in hours from three hours up, otherwise in minutes. */
function durationUnit(maxSeconds: number): { divisor: number; title: string; decimals: number } {
  return maxSeconds >= 3 * 3600
    ? { divisor: 3600, title: 'Hours', decimals: 1 }
    : { divisor: 60, title: 'Minutes', decimals: 0 };
}

function inUnit(seconds: number, divisor: number): number {
  return Math.round((seconds / divisor) * 10) / 10;
}

const EMPTY_CALLS: CallBucket[] = [];
const EMPTY_LEADS: LeadBucket[] = [];

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

/** A card's width, measured, in 50px steps so a window being dragged does not rebuild every frame. */
function useMeasuredWidth(): [(node: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    // A hidden card measures zero; keep the last real width rather than collapse.
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

type CardState = 'loading' | 'empty' | 'ready';

type ViewSwitch = {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
};

/**
 * One chart card: title and definition, the chart or its table, and a footer.
 *
 * The definition line under the title is not decoration. Several of these charts count
 * something the tile above them also counts, by a different rule — the Overdue tile is
 * every overdue follow-up, the donut only those due in the period — and the line is what
 * stops a manager reading the two as a contradiction.
 */
function ChartCard({
  title,
  subtitle,
  wide = false,
  height,
  state,
  empty,
  views,
  renderChart,
  renderTable,
  caption,
  link,
}: {
  title: string;
  subtitle?: ReactNode;
  wide?: boolean;
  height: number;
  state: CardState;
  empty: { title: string; body?: string; action?: { label: string; onClick: () => void } };
  views?: ViewSwitch;
  renderChart: (width: number) => ReactNode;
  renderTable: () => ReactNode;
  caption?: ReactNode;
  link?: { label: string; to: Destination };
}) {
  const titleId = useId();
  const [display, setDisplay] = useState<'chart' | 'table'>('chart');
  const [bodyRef, width] = useMeasuredWidth();

  return (
    <section className={wide ? 'tc-chart-card tc-chart-card--wide' : 'tc-chart-card'} aria-labelledby={titleId}>
      <header className="tc-chart-card__head">
        <div className="tc-chart-card__heading">
          <h3 id={titleId} className="tc-chart-card__title">
            {title}
          </h3>
          {subtitle ? <p className="tc-chart-card__sub">{subtitle}</p> : null}
        </div>

        {/*
          The view switch stays while a view is empty — "nobody converted anything" must
          not take away the way back to Calls — but Chart/Table only means something
          when there is a chart.
        */}
        {state !== 'loading' && (views || state === 'ready') ? (
          <div className="tc-chart-card__tools">
            {views ? (
              <div className="tc-segmented tc-segmented--sm" role="group" aria-label={views.label}>
                {views.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="tc-segmented__button"
                    aria-pressed={views.value === option.value}
                    onClick={() => views.onChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}

            {state === 'ready' ? (
              <div className="tc-segmented tc-segmented--sm" role="group" aria-label={`Show ${title} as`}>
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
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="tc-chart-card__body" ref={bodyRef} aria-busy={state === 'loading' || undefined}>
        {state === 'loading' ? (
          <div className="skeleton tc-skeleton--chart" style={{ height }} aria-hidden="true" />
        ) : state === 'empty' ? (
          <div className="tc-empty tc-empty--chart" style={{ minHeight: height }}>
            <span className="tc-empty__icon" aria-hidden="true">
              <Icon name="chart" size={22} />
            </span>
            <p className="tc-empty__title">{empty.title}</p>
            {empty.body ? <p className="tc-empty__body">{empty.body}</p> : null}
            {empty.action ? (
              <button type="button" className="btn btn--outline btn--sm" onClick={empty.action.onClick}>
                {empty.action.label}
              </button>
            ) : null}
          </div>
        ) : display === 'table' ? (
          // The chart is unmounted, not hidden: the library measures its container, and a
          // hidden one measures nothing, so a chart hidden here would come back squashed.
          <div className="tc-chart-card__table">{renderTable()}</div>
        ) : width > 0 ? (
          renderChart(width)
        ) : (
          <div className="skeleton tc-skeleton--chart" style={{ height }} aria-hidden="true" />
        )}
      </div>

      {caption || link ? (
        <footer className="tc-chart-card__foot">
          <span>{caption}</span>
          {link ? (
            <NavLink section={link.to.section} params={link.to.params}>
              {link.label}
            </NavLink>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

/**
 * The "Open" link on a row of a chart's table — the keyboard's way to do what a click on
 * the chart does. A real link, so it can also be opened in a new tab.
 */
function OpenLink({ to, label }: { to: Destination; label: string }) {
  const { linkProps } = useTelecallingNav();
  const { href, onClick } = linkProps(to.section, to.params);

  return (
    <a href={href} onClick={onClick} className="btn btn--ghost btn--sm" aria-label={label}>
      Open
    </a>
  );
}

const openColumn = <T,>(destination: (row: T) => Destination | null, label: (row: T) => string): Column<T> => ({
  key: 'open',
  header: <span className="sr-only">Open</span>,
  align: 'end',
  width: '5.5rem',
  render: (row) => {
    const to = destination(row);
    return to ? <OpenLink to={to} label={label(row)} /> : null;
  },
});

/* -------------------------------------------------------------------------- */
/* C1 — Calls                                                                 */
/* -------------------------------------------------------------------------- */

type CallsView = 'outcome' | 'direction';

/** The series of the calls chart, in stacking order (first is the bottom segment). */
function callSeries(view: CallsView) {
  return view === 'outcome'
    ? [
        { name: 'Answered', value: (bucket: CallBucket) => bucket.answered, narrow: { outcome: 'answered' } },
        { name: 'Not answered', value: (bucket: CallBucket) => bucket.notAnswered, narrow: { outcome: 'unanswered' } },
      ]
    : [
        { name: 'Outgoing', value: (bucket: CallBucket) => bucket.outgoing, narrow: { direction: 'outgoing' } },
        { name: 'Incoming', value: (bucket: CallBucket) => bucket.incoming, narrow: { direction: 'incoming' } },
      ];
}

function CallsPlot({
  data,
  tokens,
  view,
  width,
}: {
  data: DashboardAnalytics;
  tokens: ChartTokens;
  view: CallsView;
  width: number;
}) {
  const { go } = useTelecallingNav();
  const buckets = data.calls;
  const granularity = data.granularity;
  const multiDay = data.range.from !== data.range.to;
  // A list cannot show one hour of a day, so an hourly bar opens nothing.
  const clickable = granularity !== 'hour';

  const options = useMemo<ApexOptions>(() => {
    const series = callSeries(view);
    const colours = view === 'outcome' ? [tokens.series1, tokens.context] : [tokens.series1, tokens.series2];
    const axis = countAxis(Math.max(0, ...buckets.map((bucket) => bucket.total)));

    return mergeChartOptions(baseOptions(tokens), {
      chart: { type: 'bar', stacked: true },
      series: series.map((entry) => ({ name: entry.name, data: buckets.map(entry.value) })),
      colors: colours,
      plotOptions: {
        bar: {
          horizontal: false,
          columnWidth: columnWidth(width, buckets.length),
          borderRadius: 4,
          borderRadiusApplication: 'end',
          borderRadiusWhenStacked: 'last',
        },
      },
      // The 2px gap between stacked segments, in the surface colour.
      stroke: { show: true, width: 2, colors: [tokens.surface] },
      xaxis: { type: 'category', categories: buckets.map((bucket) => axisLabel(bucket, granularity)) },
      yaxis: {
        ...axis,
        labels: { formatter: countLabel },
        title: { text: 'Calls', style: { color: tokens.textMuted, fontSize: '12px', fontWeight: 500 } },
      },
      tooltip: {
        shared: true,
        intersect: false,
        custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
          const bucket = buckets[dataPointIndex];
          if (!bucket) return '';

          const rows: TooltipRow[] =
            view === 'outcome'
              ? [
                  {
                    colour: colours[0],
                    label: 'Answered',
                    value: formatCount(bucket.answered),
                    note: bucket.total > 0 ? `(${percent(bucket.answered, bucket.total)}%)` : undefined,
                  },
                  { colour: colours[1], label: 'Not answered', value: formatCount(bucket.notAnswered) },
                ]
              : [
                  { colour: colours[0], label: 'Outgoing', value: formatCount(bucket.outgoing) },
                  {
                    colour: colours[1],
                    label: 'Incoming',
                    value: formatCount(bucket.incoming),
                    note:
                      bucket.incoming > 0 ? `(${formatCount(bucket.incomingNotAnswered)} not answered)` : undefined,
                  },
                ];

          return tooltipHtml({
            title: `${bucketTitle(bucket, granularity, multiDay)} · ${plural(bucket.total, 'call')}`,
            rows,
            footer: clickable && bucket.total > 0 ? 'Click a bar to open these calls' : undefined,
          });
        },
      },
    });
  }, [buckets, granularity, multiDay, clickable, tokens, view, width]);

  const total = sum(buckets, (bucket) => bucket.total);
  const answered = sum(buckets, (bucket) => bucket.answered);

  return (
    <ApexChart
      options={options}
      height={300}
      label={`Calls by ${granularity}, ${formatDateRange(data.range)}: ${plural(total, 'call')}, ${percent(answered, total)}% answered.`}
      onPointClick={
        clickable
          ? (hit: ChartHit) => {
              const bucket = buckets[hit.dataPointIndex];
              if (!bucket || bucket.total === 0) return;
              // A segment opens its own outcome or direction; anywhere else in the bucket
              // opens all of the bucket's calls.
              const segment = hit.seriesIndex === null ? undefined : callSeries(view)[hit.seriesIndex];
              go('calls', callsInBucket(bucket, segment?.narrow).params);
            }
          : undefined
      }
    />
  );
}

function CallsCard({
  data,
  tokens,
  onWiden,
}: {
  data: DashboardAnalytics | null;
  tokens: ChartTokens | null;
  onWiden?: () => void;
}) {
  const [view, setView] = useState<CallsView>('outcome');
  const buckets = data?.calls ?? EMPTY_CALLS;
  const total = sum(buckets, (bucket) => bucket.total);
  const granularity = data?.granularity ?? 'day';
  const multiDay = data ? data.range.from !== data.range.to : false;
  const clickable = granularity !== 'hour';

  const columns: Column<CallBucket>[] = [
    {
      key: 'period',
      header: 'Period',
      render: (bucket) => bucketTitle(bucket, granularity, multiDay),
    },
    { key: 'calls', header: 'Calls', align: 'end', render: (bucket) => formatCount(bucket.total) },
    { key: 'answered', header: 'Answered', align: 'end', render: (bucket) => formatCount(bucket.answered) },
    { key: 'not', header: 'Not answered', align: 'end', render: (bucket) => formatCount(bucket.notAnswered) },
    {
      key: 'rate',
      header: 'Answer rate',
      align: 'end',
      render: (bucket) => (bucket.total > 0 ? `${percent(bucket.answered, bucket.total)}%` : '—'),
    },
    { key: 'out', header: 'Outgoing', align: 'end', render: (bucket) => formatCount(bucket.outgoing) },
    { key: 'in', header: 'Incoming', align: 'end', render: (bucket) => formatCount(bucket.incoming) },
    { key: 'talk', header: 'Talk time', align: 'end', render: (bucket) => talkTime(bucket.talkTimeSeconds) },
    openColumn<CallBucket>(
      (bucket) => (clickable && bucket.total > 0 ? callsInBucket(bucket) : null),
      (bucket) => `Open the calls for ${bucketTitle(bucket, granularity, multiDay)}`,
    ),
  ];

  return (
    <ChartCard
      wide
      title="Calls"
      subtitle={
        view === 'outcome'
          ? 'Answered and not answered, by when each call started. Incoming calls count when they reached a company SIM.'
          : 'Calls made and calls received, by when each call started. Incoming calls count when they reached a company SIM.'
      }
      height={300}
      state={!data || !tokens ? 'loading' : total === 0 ? 'empty' : 'ready'}
      empty={{
        title: 'No calls were logged in this period.',
        body: onWiden ? 'A longer period may have some.' : undefined,
        action: onWiden ? { label: 'Show last 90 days', onClick: onWiden } : undefined,
      }}
      views={{
        label: 'Split calls by',
        value: view,
        options: [
          { value: 'outcome', label: 'Outcome' },
          { value: 'direction', label: 'Direction' },
        ],
        onChange: (next) => setView(next === 'direction' ? 'direction' : 'outcome'),
      }}
      renderChart={(width) =>
        data && tokens ? <CallsPlot data={data} tokens={tokens} view={view} width={width} /> : null
      }
      renderTable={() => (
        <DataTable
          rows={buckets}
          rowKey={(bucket) => bucket.bucket}
          columns={columns}
          minWidth="52rem"
          caption={`Calls by ${granularity}`}
        />
      )}
      caption={clickable ? undefined : 'Hourly bars cannot be opened as a list. Choose days to open them.'}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* C2 — Talk time                                                             */
/* -------------------------------------------------------------------------- */

function TalkTimePlot({
  data,
  tokens,
  width,
}: {
  data: DashboardAnalytics;
  tokens: ChartTokens;
  width: number;
}) {
  const { go } = useTelecallingNav();
  const buckets = data.calls;
  const granularity = data.granularity;
  const multiDay = data.range.from !== data.range.to;
  const clickable = granularity !== 'hour';

  const options = useMemo<ApexOptions>(() => {
    const unit = durationUnit(Math.max(0, ...buckets.map((bucket) => bucket.talkTimeSeconds)));

    return mergeChartOptions(baseOptions(tokens), {
      chart: { type: 'area', stacked: false },
      series: [{ name: 'Talk time', data: buckets.map((bucket) => inUnit(bucket.talkTimeSeconds, unit.divisor)) }],
      colors: [tokens.series1],
      stroke: { show: true, width: 2, curve: 'straight', lineCap: 'round', colors: [tokens.series1] },
      // A wash under the line, never a saturated block.
      fill: { type: 'solid', opacity: 0.1 },
      markers: {
        // One point has no line to draw, so it needs a dot to be visible at all.
        size: buckets.length === 1 ? 5 : 0,
        colors: [tokens.series1],
        strokeColors: tokens.surface,
        strokeWidth: 2,
        hover: { size: 5 },
      },
      xaxis: {
        type: 'category',
        categories: buckets.map((bucket) => axisLabel(bucket, granularity)),
        tickAmount: lineTickAmount(width, buckets.length),
      },
      yaxis: {
        min: 0,
        max: undefined,
        tickAmount: undefined,
        forceNiceScale: true,
        decimalsInFloat: unit.decimals,
        labels: {
          formatter: (value: number) => (unit.decimals > 0 ? Number(value).toFixed(1) : countLabel(value)),
        },
        title: { text: unit.title, style: { color: tokens.textMuted, fontSize: '12px', fontWeight: 500 } },
      },
      legend: { show: false },
      tooltip: {
        shared: true,
        intersect: false,
        custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
          const bucket = buckets[dataPointIndex];
          if (!bucket) return '';
          return tooltipHtml({
            title: bucketTitle(bucket, granularity, multiDay),
            rows: [
              { colour: tokens.series1, label: 'talk time', value: talkTime(bucket.talkTimeSeconds) },
              bucket.answered > 0
                ? {
                    label: 'average call',
                    value: formatClock(bucket.averageDurationSeconds),
                    note: `over ${plural(bucket.answered, 'answered call')}`,
                  }
                : { label: 'answered calls', value: '0' },
            ],
            footer: clickable && bucket.answered > 0 ? 'Click to open the answered calls' : undefined,
          });
        },
      },
    });
  }, [buckets, granularity, multiDay, clickable, tokens, width]);

  const talk = sum(buckets, (bucket) => bucket.talkTimeSeconds);
  const answered = sum(buckets, (bucket) => bucket.answered);

  return (
    <ApexChart
      options={options}
      height={260}
      label={`Talk time by ${granularity}, ${formatDateRange(data.range)}: ${talkTime(talk)} over ${plural(answered, 'answered call')}.`}
      onPointClick={
        clickable
          ? (hit: ChartHit) => {
              const bucket = buckets[hit.dataPointIndex];
              if (bucket && bucket.answered > 0) go('calls', callsInBucket(bucket, { outcome: 'answered' }).params);
            }
          : undefined
      }
    />
  );
}

function TalkTimeCard({ data, tokens }: { data: DashboardAnalytics | null; tokens: ChartTokens | null }) {
  const buckets = data?.calls ?? EMPTY_CALLS;
  const talk = sum(buckets, (bucket) => bucket.talkTimeSeconds);
  const granularity = data?.granularity ?? 'day';
  const multiDay = data ? data.range.from !== data.range.to : false;
  const clickable = granularity !== 'hour';

  const columns: Column<CallBucket>[] = [
    { key: 'period', header: 'Period', render: (bucket) => bucketTitle(bucket, granularity, multiDay) },
    { key: 'talk', header: 'Talk time', align: 'end', render: (bucket) => talkTime(bucket.talkTimeSeconds) },
    { key: 'answered', header: 'Answered calls', align: 'end', render: (bucket) => formatCount(bucket.answered) },
    {
      key: 'average',
      header: 'Average call',
      align: 'end',
      render: (bucket) => (bucket.answered > 0 ? formatClock(bucket.averageDurationSeconds) : '—'),
    },
    openColumn<CallBucket>(
      (bucket) => (clickable && bucket.answered > 0 ? callsInBucket(bucket, { outcome: 'answered' }) : null),
      (bucket) => `Open the answered calls for ${bucketTitle(bucket, granularity, multiDay)}`,
    ),
  ];

  return (
    <ChartCard
      title="Talk time"
      subtitle="Time spent on answered calls."
      height={260}
      state={!data || !tokens ? 'loading' : talk === 0 ? 'empty' : 'ready'}
      empty={{ title: 'No answered calls in this period, so there is no talk time to show.' }}
      renderChart={(width) =>
        data && tokens ? <TalkTimePlot data={data} tokens={tokens} width={width} /> : null
      }
      renderTable={() => (
        <DataTable
          rows={buckets}
          rowKey={(bucket) => bucket.bucket}
          columns={columns}
          minWidth="30rem"
          caption={`Talk time by ${granularity}`}
        />
      )}
      caption="Answered calls only. iPhone call durations are entered by the telecaller."
    />
  );
}

/* -------------------------------------------------------------------------- */
/* C3 — Follow-ups due in this period                                         */
/* -------------------------------------------------------------------------- */

type FollowUpSlice = { label: string; value: number; colour: string; scope: FollowUpScope | null };

/**
 * The donut's slices, in a fixed order with fixed status colours.
 *
 * Each clickable slice opens the follow-up list with the scope that is its own definition
 * — completed, overdue, upcoming — limited to the same due dates. Cancelled has no list
 * scope, so its slice does not open anything.
 */
function followUpSlices(data: DashboardAnalytics, tokens: ChartTokens | null): FollowUpSlice[] {
  const followUps = data.followUps;
  return [
    { label: 'Completed', value: followUps.completed, colour: tokens?.good ?? '', scope: 'completed' },
    { label: 'Overdue', value: followUps.overdue, colour: tokens?.critical ?? '', scope: 'overdue' },
    { label: 'Not yet due', value: followUps.upcoming, colour: tokens?.info ?? '', scope: 'upcoming' },
    { label: 'Cancelled', value: followUps.cancelled, colour: tokens?.context ?? '', scope: null },
  ];
}

function followUpsDestination(scope: FollowUpScope, request: DateRange): Destination {
  return { section: 'followups', params: { scope, from: request.from, to: request.to } };
}

function FollowUpsPlot({
  data,
  request,
  tokens,
}: {
  data: DashboardAnalytics;
  request: DateRange;
  tokens: ChartTokens;
}) {
  const { go } = useTelecallingNav();
  const slices = useMemo(() => followUpSlices(data, tokens), [data, tokens]);
  const total = data.followUps.total;

  const options = useMemo<ApexOptions>(
    () =>
      mergeChartOptions(baseOptions(tokens), {
        chart: { type: 'donut', stacked: false },
        series: slices.map((slice) => slice.value),
        labels: slices.map((slice) => slice.label),
        colors: slices.map((slice) => slice.colour),
        stroke: { show: true, width: 2, colors: [tokens.surface] },
        dataLabels: {
          enabled: true,
          // A percentage on a sliver is unreadable; small slices leave it to the legend.
          formatter: (value: string | number | number[]) => {
            const share = Number(value);
            return share >= 8 ? `${Math.round(share)}%` : '';
          },
          style: {
            fontSize: '12px',
            fontWeight: 600,
            // White on the three dark status colours, ink on the light grey.
            colors: [tokens.surface, tokens.surface, tokens.surface, tokens.text],
          },
          dropShadow: { enabled: false },
        },
        plotOptions: {
          pie: {
            expandOnClick: false,
            donut: {
              size: '68%',
              labels: {
                show: true,
                name: { show: true, fontSize: '12px', fontWeight: 500, color: tokens.textMuted, offsetY: 20 },
                value: {
                  show: true,
                  fontSize: '24px',
                  fontWeight: 700,
                  color: tokens.text,
                  offsetY: -14,
                  formatter: (value: string) => countLabel(value),
                },
                total: {
                  show: true,
                  showAlways: true,
                  label: 'Due',
                  fontSize: '12px',
                  fontWeight: 500,
                  color: tokens.textMuted,
                  formatter: () => formatCount(total),
                },
              },
            },
          },
        },
        legend: {
          position: 'bottom',
          horizontalAlign: 'center',
          formatter: (name: string, opts?: { seriesIndex?: number }) => {
            const slice = opts?.seriesIndex === undefined ? undefined : slices[opts.seriesIndex];
            return escapeHtml(slice ? `${name} · ${formatCount(slice.value)}` : name);
          },
        },
        tooltip: {
          shared: false,
          intersect: true,
          custom: ({ seriesIndex }: { seriesIndex: number }) => {
            const slice = slices[seriesIndex];
            if (!slice) return '';
            const rows: TooltipRow[] = [
              {
                colour: slice.colour,
                label: slice.value === 1 ? 'follow-up' : 'follow-ups',
                value: formatCount(slice.value),
                note: `(${percent(slice.value, total)}% of ${formatCount(total)})`,
              },
            ];
            if (slice.scope === 'completed') {
              rows.push(
                { label: 'on time', value: formatCount(data.followUps.completedOnTime) },
                { label: 'late', value: formatCount(data.followUps.completedLate) },
              );
            }
            return tooltipHtml({
              title: slice.label,
              rows,
              footer: slice.scope && slice.value > 0 ? 'Click to open these follow-ups' : undefined,
            });
          },
        },
      }),
    [slices, total, tokens, data.followUps.completedOnTime, data.followUps.completedLate],
  );

  const followUps = data.followUps;

  return (
    <ApexChart
      options={options}
      height={280}
      label={`Follow-ups due ${formatDateRange(data.range)}: ${formatCount(total)} in all — ${formatCount(followUps.completed)} completed, ${formatCount(followUps.overdue)} overdue, ${formatCount(followUps.upcoming)} not yet due, ${formatCount(followUps.cancelled)} cancelled.`}
      onPointClick={(hit: ChartHit) => {
        const slice = slices[hit.dataPointIndex];
        if (slice?.scope && slice.value > 0) {
          const to = followUpsDestination(slice.scope, request);
          go(to.section, to.params);
        }
      }}
    />
  );
}

function FollowUpsCard({
  data,
  request,
  tokens,
}: {
  data: DashboardAnalytics | null;
  request: DateRange;
  tokens: ChartTokens | null;
}) {
  const followUps = data?.followUps;
  const slices = data ? followUpSlices(data, tokens) : [];

  const columns: Column<FollowUpSlice>[] = [
    { key: 'status', header: 'Status', render: (slice) => slice.label },
    { key: 'count', header: 'Follow-ups', align: 'end', render: (slice) => formatCount(slice.value) },
    {
      key: 'share',
      header: 'Share',
      align: 'end',
      render: (slice) => `${percent(slice.value, followUps?.total ?? 0)}%`,
    },
    openColumn<FollowUpSlice>(
      (slice) => (slice.scope && slice.value > 0 ? followUpsDestination(slice.scope, request) : null),
      (slice) => `Open the ${slice.label.toLowerCase()} follow-ups`,
    ),
  ];

  const caption = followUps
    ? followUps.completed > 0
      ? `${formatCount(followUps.completedOnTime)} of ${formatCount(followUps.completed)} completed on time (${percent(followUps.completedOnTime, followUps.completed)}%)`
      : 'None of these has been completed yet.'
    : undefined;

  return (
    <ChartCard
      title="Follow-ups due in this period"
      subtitle="Follow-ups that fell due in the period, by what became of them. The Overdue tile counts every overdue follow-up, whenever it fell due."
      height={280}
      state={!data || !tokens ? 'loading' : (followUps?.total ?? 0) === 0 ? 'empty' : 'ready'}
      empty={{ title: 'No follow-ups fell due in this period.' }}
      renderChart={() => (data && tokens ? <FollowUpsPlot data={data} request={request} tokens={tokens} /> : null)}
      renderTable={() => (
        <DataTable
          rows={slices}
          rowKey={(slice) => slice.label}
          columns={columns}
          minWidth="24rem"
          caption="Follow-ups due in this period, by what became of them"
        />
      )}
      caption={caption}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* C4 — Leads by status                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Display order: the working stages first, the good outcomes, then the dead ends. Every
 * status is listed, zeros included, so a status's row never moves between periods.
 */
const STATUS_ORDER: LeadStatus[] = [
  'new',
  'contacted',
  'interested',
  'follow_up',
  'callback_requested',
  'walked_in',
  'converted',
  'not_interested',
  'not_reachable',
  'invalid_number',
  'lost',
];

type StatusRow = { status: LeadStatus; label: string; count: number };

function statusRows(data: DashboardAnalytics): StatusRow[] {
  const counts = new Map(data.leadsByStatus.map((row) => [row.status, row.count]));
  return STATUS_ORDER.map((status) => ({ status, label: LEAD_STATUS_LABELS[status], count: counts.get(status) ?? 0 }));
}

function LeadsByStatusPlot({
  rows,
  data,
  tokens,
  window,
}: {
  rows: StatusRow[];
  data: DashboardAnalytics;
  tokens: ChartTokens;
  window: UrlParams;
}) {
  const { go } = useTelecallingNav();
  const total = sum(rows, (row) => row.count);

  const options = useMemo<ApexOptions>(() => {
    const axis = countAxis(Math.max(0, ...rows.map((row) => row.count)));

    return mergeChartOptions(baseOptions(tokens), {
      chart: { type: 'bar', stacked: false },
      // Nominal categories, so one colour for every bar: a darker-where-bigger ramp would
      // only say again what the bar length already says.
      series: [{ name: 'Leads', data: rows.map((row) => row.count) }],
      colors: [tokens.series1],
      plotOptions: {
        bar: {
          horizontal: true,
          barHeight: '70%',
          borderRadius: 4,
          borderRadiusApplication: 'end',
          dataLabels: { position: 'top' },
        },
      },
      stroke: { show: false, width: 0, colors: [tokens.surface] },
      dataLabels: {
        enabled: true,
        formatter: (value: string | number | number[]) => (Number(value) > 0 ? countLabel(Number(value)) : ''),
        offsetX: 26,
        style: { fontSize: '12px', fontWeight: 600, colors: [tokens.text] },
        dropShadow: { enabled: false },
      },
      grid: {
        xaxis: { lines: { show: true } },
        yaxis: { lines: { show: false } },
        padding: { top: 0, right: 36, bottom: 0, left: 8 },
      },
      // In a horizontal chart the categories run down the y-axis, and the counts along x.
      xaxis: { type: 'category', categories: rows.map((row) => row.label), labels: { formatter: countLabel } },
      yaxis: { ...axis, labels: { maxWidth: 150 } },
      legend: { show: false },
      tooltip: {
        shared: false,
        intersect: false,
        custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
          const row = rows[dataPointIndex];
          if (!row) return '';
          return tooltipHtml({
            title: row.label,
            rows: [
              {
                colour: tokens.series1,
                label: row.count === 1 ? 'lead' : 'leads',
                value: formatCount(row.count),
                note: `(${percent(row.count, total)}% of ${formatCount(total)})`,
              },
            ],
            footer: row.count > 0 ? 'Click to open these leads' : undefined,
          });
        },
      },
    });
  }, [rows, total, tokens]);

  const top = [...rows].sort((a, b) => b.count - a.count)[0];

  return (
    <ApexChart
      options={options}
      height={364}
      label={`Leads created ${formatDateRange(data.range)}, by where they stand now: ${plural(total, 'lead')}${top && top.count > 0 ? `, most of them ${top.label.toLowerCase()} (${formatCount(top.count)})` : ''}.`}
      onPointClick={(hit: ChartHit) => {
        const row = rows[hit.dataPointIndex];
        if (row && row.count > 0) go('leads', { ...window, status: row.status });
      }}
    />
  );
}

function LeadsByStatusCard({
  data,
  tokens,
  window,
}: {
  data: DashboardAnalytics | null;
  tokens: ChartTokens | null;
  window: UrlParams;
}) {
  const rows = useMemo(() => (data ? statusRows(data) : []), [data]);
  const total = sum(rows, (row) => row.count);

  const columns: Column<StatusRow>[] = [
    { key: 'status', header: 'Status', render: (row) => row.label },
    { key: 'count', header: 'Leads', align: 'end', render: (row) => formatCount(row.count) },
    { key: 'share', header: 'Share', align: 'end', render: (row) => `${percent(row.count, total)}%` },
    openColumn<StatusRow>(
      (row) => (row.count > 0 ? { section: 'leads', params: { ...window, status: row.status } } : null),
      (row) => `Open the ${row.label.toLowerCase()} leads`,
    ),
  ];

  return (
    <ChartCard
      title="Leads by status"
      subtitle="Where the leads created in this period stand now."
      height={364}
      state={!data || !tokens ? 'loading' : total === 0 ? 'empty' : 'ready'}
      empty={{ title: 'No leads were created in this period.' }}
      renderChart={() =>
        data && tokens ? <LeadsByStatusPlot rows={rows} data={data} tokens={tokens} window={window} /> : null
      }
      renderTable={() => (
        <DataTable
          rows={rows}
          rowKey={(row) => row.status}
          columns={columns}
          minWidth="24rem"
          caption="Leads created in this period, by status"
        />
      )}
      link={{ label: 'Open these leads', to: { section: 'leads', params: window } }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* C5 — New leads and conversions                                             */
/* -------------------------------------------------------------------------- */

function newLeadsInBucket(bucket: LeadBucket): Destination {
  return { section: 'leads', params: { from: bucket.from, to: bucket.to } };
}

function conversionsInBucket(bucket: LeadBucket): Destination {
  return {
    section: 'leads',
    params: { status: 'converted', convertedFrom: bucket.from, convertedTo: bucket.to },
  };
}

function LeadTrendPlot({
  data,
  tokens,
  width,
}: {
  data: DashboardAnalytics;
  tokens: ChartTokens;
  width: number;
}) {
  const { go } = useTelecallingNav();
  const buckets = data.leads;
  const granularity = data.granularity;
  const multiDay = data.range.from !== data.range.to;
  const clickable = granularity !== 'hour';

  const options = useMemo<ApexOptions>(() => {
    const axis = countAxis(Math.max(0, ...buckets.map((bucket) => Math.max(bucket.created, bucket.converted))));

    return mergeChartOptions(baseOptions(tokens), {
      // A mixed chart: columns for the new leads, a line for conversions, on one axis —
      // both are counts of leads, so a second scale would only invent a relationship.
      chart: { type: 'line', stacked: false },
      series: [
        { name: 'New leads', type: 'column', data: buckets.map((bucket) => bucket.created) },
        { name: 'Converted', type: 'line', data: buckets.map((bucket) => bucket.converted) },
      ],
      colors: [tokens.series1, tokens.series2],
      stroke: { show: true, width: [0, 2], curve: 'straight', lineCap: 'round', colors: [tokens.series1, tokens.series2] },
      fill: { type: 'solid', opacity: 1 },
      markers: {
        size: [0, 4],
        colors: [tokens.series1, tokens.series2],
        strokeColors: tokens.surface,
        strokeWidth: 2,
        hover: { sizeOffset: 2 },
      },
      plotOptions: {
        bar: {
          horizontal: false,
          columnWidth: columnWidth(width, buckets.length),
          borderRadius: 4,
          borderRadiusApplication: 'end',
        },
      },
      xaxis: {
        type: 'category',
        categories: buckets.map((bucket) => axisLabel(bucket, granularity)),
        tickAmount: lineTickAmount(width, buckets.length),
      },
      yaxis: {
        ...axis,
        labels: { formatter: countLabel },
        title: { text: 'Leads', style: { color: tokens.textMuted, fontSize: '12px', fontWeight: 500 } },
      },
      // A circle for the conversions line, like its points: the library draws no marker at
      // all for the 'line' shape here, which left "Converted" in the legend with no key.
      legend: { markers: { size: 5, strokeWidth: 0, shape: ['square', 'circle'] } },
      tooltip: {
        shared: true,
        intersect: false,
        custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
          const bucket = buckets[dataPointIndex];
          if (!bucket) return '';
          return tooltipHtml({
            title: bucketTitle(bucket, granularity, multiDay),
            rows: [
              { colour: tokens.series1, label: bucket.created === 1 ? 'new lead' : 'new leads', value: formatCount(bucket.created) },
              { colour: tokens.series2, label: 'converted', value: formatCount(bucket.converted) },
            ],
            footer: clickable ? 'Click a column or a point to open those leads' : undefined,
          });
        },
      },
    });
  }, [buckets, granularity, multiDay, clickable, tokens, width]);

  const created = sum(buckets, (bucket) => bucket.created);
  const converted = sum(buckets, (bucket) => bucket.converted);

  return (
    <ApexChart
      options={options}
      height={300}
      label={`New leads and conversions by ${granularity}, ${formatDateRange(data.range)}: ${plural(created, 'new lead')}, ${formatCount(converted)} converted.`}
      onPointClick={
        clickable
          ? (hit: ChartHit) => {
              const bucket = buckets[hit.dataPointIndex];
              if (!bucket || hit.seriesIndex === null) return;
              const to =
                hit.seriesIndex === 0
                  ? bucket.created > 0
                    ? newLeadsInBucket(bucket)
                    : null
                  : bucket.converted > 0
                    ? conversionsInBucket(bucket)
                    : null;
              if (to) go(to.section, to.params);
            }
          : undefined
      }
    />
  );
}

function LeadTrendCard({
  data,
  tokens,
  window,
}: {
  data: DashboardAnalytics | null;
  tokens: ChartTokens | null;
  window: UrlParams;
}) {
  const buckets = data?.leads ?? EMPTY_LEADS;
  const created = sum(buckets, (bucket) => bucket.created);
  const converted = sum(buckets, (bucket) => bucket.converted);
  const granularity = data?.granularity ?? 'day';
  const multiDay = data ? data.range.from !== data.range.to : false;
  const clickable = granularity !== 'hour';

  const columns: Column<LeadBucket>[] = [
    { key: 'period', header: 'Period', render: (bucket) => bucketTitle(bucket, granularity, multiDay) },
    {
      key: 'created',
      header: 'New leads',
      align: 'end',
      render: (bucket) =>
        clickable && bucket.created > 0 ? (
          <NavLink section="leads" params={newLeadsInBucket(bucket).params}>
            {formatCount(bucket.created)}
          </NavLink>
        ) : (
          formatCount(bucket.created)
        ),
    },
    {
      key: 'converted',
      header: 'Converted',
      align: 'end',
      render: (bucket) =>
        clickable && bucket.converted > 0 ? (
          <NavLink section="leads" params={conversionsInBucket(bucket).params}>
            {formatCount(bucket.converted)}
          </NavLink>
        ) : (
          formatCount(bucket.converted)
        ),
    },
  ];

  return (
    <ChartCard
      title="New leads and conversions"
      subtitle="Leads created in each period, and leads marked converted in it — counted on the day they were marked, whenever they were created."
      height={300}
      state={!data || !tokens ? 'loading' : created + converted === 0 ? 'empty' : 'ready'}
      empty={{ title: 'No leads were created or converted in this period.' }}
      renderChart={(width) => (data && tokens ? <LeadTrendPlot data={data} tokens={tokens} width={width} /> : null)}
      renderTable={() => (
        <DataTable
          rows={buckets}
          rowKey={(bucket) => bucket.bucket}
          columns={columns}
          minWidth="24rem"
          caption={`New leads and conversions by ${granularity}`}
        />
      )}
      caption={clickable ? undefined : 'Hourly figures cannot be opened as a list. Choose days to open them.'}
      link={{ label: 'Open these leads', to: { section: 'leads', params: window } }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* C6 — Telecallers                                                           */
/* -------------------------------------------------------------------------- */

type TelecallerView = 'calls' | 'talk' | 'converted';

const TELECALLER_METRIC: Record<TelecallerView, (row: EmployeePerformance) => number> = {
  calls: (row) => row.calls,
  talk: (row) => row.talkTimeSeconds,
  converted: (row) => row.leadsConverted,
};

/** How many people the chart ranks. The full comparison is Reports' job. */
const TOP_TELECALLERS = 10;

function rankTelecallers(rows: EmployeePerformance[], view: TelecallerView): EmployeePerformance[] {
  const metric = TELECALLER_METRIC[view];
  return rows
    .filter((row) => metric(row) > 0)
    .sort((a, b) => metric(b) - metric(a) || a.name.localeCompare(b.name))
    .slice(0, TOP_TELECALLERS);
}

/**
 * Where a telecaller's bar leads. Calls and talk time open that person's calls in the same
 * window. Conversions open nothing: the figure includes leads that were later archived,
 * which the leads list never shows, so the two could disagree.
 */
function telecallerDestination(
  row: EmployeePerformance,
  view: TelecallerView,
  calls: UrlParams,
  seriesIndex: number | null,
): Destination | null {
  if (view === 'converted') return null;
  const outcome =
    view === 'talk' ? 'answered' : seriesIndex === 0 ? 'answered' : seriesIndex === 1 ? 'unanswered' : undefined;
  return { section: 'calls', params: { ...calls, userId: row.userId, outcome } };
}

function telecallersHeight(count: number): number {
  return Math.max(160, count * 32 + 64);
}

function TelecallersPlot({
  ranked,
  view,
  tokens,
  calls,
}: {
  ranked: EmployeePerformance[];
  view: TelecallerView;
  tokens: ChartTokens;
  calls: UrlParams;
}) {
  const { go } = useTelecallingNav();

  const options = useMemo<ApexOptions>(() => {
    const unit = durationUnit(Math.max(0, ...ranked.map((row) => row.talkTimeSeconds)));
    const stacked = view === 'calls';
    const series =
      view === 'calls'
        ? [
            { name: 'Answered', data: ranked.map((row) => row.answered) },
            { name: 'Not answered', data: ranked.map((row) => row.missed) },
          ]
        : view === 'talk'
          ? [{ name: 'Talk time', data: ranked.map((row) => inUnit(row.talkTimeSeconds, unit.divisor)) }]
          : [{ name: 'Converted', data: ranked.map((row) => row.leadsConverted) }];
    const colours =
      view === 'calls' ? [tokens.series1, tokens.context] : view === 'talk' ? [tokens.series1] : [tokens.series2];
    const max = Math.max(0, ...series.flatMap((entry) => entry.data));
    const counts = view !== 'talk';

    return mergeChartOptions(baseOptions(tokens), {
      chart: { type: 'bar', stacked },
      series,
      colors: colours,
      plotOptions: {
        bar: {
          horizontal: true,
          barHeight: '70%',
          borderRadius: 4,
          borderRadiusApplication: 'end',
          borderRadiusWhenStacked: 'last',
          dataLabels: { position: 'center' },
        },
      },
      stroke: { show: stacked, width: stacked ? 2 : 0, colors: [tokens.surface] },
      dataLabels: { enabled: false },
      grid: {
        xaxis: { lines: { show: true } },
        yaxis: { lines: { show: false } },
        padding: { top: 0, right: 16, bottom: 0, left: 8 },
      },
      // Names are drawn by the library as SVG text, which is never parsed as markup, so
      // they go in raw; escaping them here would print "&amp;" for an ampersand.
      xaxis: {
        type: 'category',
        categories: ranked.map((row) => row.name),
        labels: {
          formatter: (value: string | number) =>
            counts ? countLabel(value) : unit.decimals > 0 ? Number(value).toFixed(1) : countLabel(value),
        },
        title: {
          text: view === 'talk' ? unit.title : undefined,
          style: { color: tokens.textMuted, fontSize: '12px', fontWeight: 500 },
        },
      },
      yaxis: counts
        ? { ...countAxis(max), labels: { maxWidth: 160 } }
        : {
            min: 0,
            max: undefined,
            tickAmount: undefined,
            forceNiceScale: true,
            decimalsInFloat: unit.decimals,
            labels: { maxWidth: 160 },
          },
      legend: { show: view === 'calls' },
      tooltip: {
        shared: true,
        intersect: false,
        custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
          const row = ranked[dataPointIndex];
          if (!row) return '';

          const rows: TooltipRow[] =
            view === 'calls'
              ? [
                  {
                    colour: tokens.series1,
                    label: 'answered',
                    value: formatCount(row.answered),
                    note: row.calls > 0 ? `(${percent(row.answered, row.calls)}%)` : undefined,
                  },
                  { colour: tokens.context, label: 'not answered', value: formatCount(row.missed) },
                  { label: 'talk time', value: talkTime(row.talkTimeSeconds) },
                ]
              : view === 'talk'
                ? [
                    { colour: tokens.series1, label: 'talk time', value: talkTime(row.talkTimeSeconds) },
                    {
                      label: 'average call',
                      value: formatClock(row.averageDurationSeconds),
                      note: `over ${plural(row.answered, 'answered call')}`,
                    },
                  ]
                : [
                    { colour: tokens.series2, label: 'converted', value: formatCount(row.leadsConverted) },
                    { label: 'calls', value: formatCount(row.calls) },
                  ];

          // The name is an employee's own input; tooltipHtml escapes it with everything else.
          return tooltipHtml({
            title: row.isActive ? row.name : `${row.name} (deactivated)`,
            rows,
            footer: view === 'converted' ? undefined : 'Click to open their calls',
          });
        },
      },
    });
  }, [ranked, view, tokens]);

  const first = ranked[0];
  const viewWord = view === 'calls' ? 'calls' : view === 'talk' ? 'talk time' : 'conversions';

  return (
    <ApexChart
      options={options}
      height={telecallersHeight(ranked.length)}
      label={`The ${ranked.length} telecallers with the most ${viewWord} in this period${first ? `, led by ${first.name}` : ''}.`}
      onPointClick={
        view === 'converted'
          ? undefined
          : (hit: ChartHit) => {
              const row = ranked[hit.dataPointIndex];
              const to = row ? telecallerDestination(row, view, calls, hit.seriesIndex) : null;
              if (to) go(to.section, to.params);
            }
      }
    />
  );
}

function TelecallersCard({
  rows,
  tokens,
  calls,
}: {
  rows: EmployeePerformance[] | null;
  tokens: ChartTokens | null;
  calls: UrlParams;
}) {
  const [view, setView] = useState<TelecallerView>('calls');
  const ranked = useMemo(() => (rows ? rankTelecallers(rows, view) : []), [rows, view]);
  const withCalls = rows ? rows.filter((row) => row.calls > 0).length : 0;

  const columns: Column<EmployeePerformance>[] = [
    {
      key: 'name',
      header: 'Employee',
      render: (row) => (row.isActive ? row.name : `${row.name} (deactivated)`),
    },
    { key: 'calls', header: 'Calls', align: 'end', render: (row) => formatCount(row.calls) },
    { key: 'answered', header: 'Answered', align: 'end', render: (row) => formatCount(row.answered) },
    { key: 'missed', header: 'Not answered', align: 'end', render: (row) => formatCount(row.missed) },
    { key: 'talk', header: 'Talk time', align: 'end', render: (row) => talkTime(row.talkTimeSeconds) },
    {
      key: 'average',
      header: 'Average call',
      align: 'end',
      render: (row) => (row.answered > 0 ? formatClock(row.averageDurationSeconds) : '—'),
    },
    { key: 'converted', header: 'Converted', align: 'end', render: (row) => formatCount(row.leadsConverted) },
    openColumn<EmployeePerformance>(
      (row) => telecallerDestination(row, view, calls, null),
      (row) => `Open ${row.name}'s calls`,
    ),
  ];

  const empty =
    view === 'calls'
      ? 'No calls were logged in this period.'
      : view === 'talk'
        ? 'No answered calls in this period, so there is no talk time to compare.'
        : 'No leads were converted in this period.';

  const caption =
    view === 'converted'
      ? 'Converted counts every lead marked converted in this period, including any archived since.'
      : withCalls > ranked.length
        ? `The ${ranked.length} busiest of ${formatCount(withCalls)} people who made calls.`
        : `${plural(withCalls, 'person', 'people')} made calls in this period.`;

  return (
    <ChartCard
      wide
      title="Telecallers"
      subtitle={
        view === 'calls'
          ? 'The busiest people by calls, answered and not.'
          : view === 'talk'
            ? 'The busiest people by time spent on answered calls.'
            : 'Who converted the most leads in this period.'
      }
      height={telecallersHeight(Math.max(ranked.length, 3))}
      state={!rows || !tokens ? 'loading' : ranked.length === 0 ? 'empty' : 'ready'}
      empty={{ title: empty }}
      views={{
        label: 'Rank telecallers by',
        value: view,
        options: [
          { value: 'calls', label: 'Calls' },
          { value: 'talk', label: 'Talk time' },
          { value: 'converted', label: 'Converted' },
        ],
        onChange: (next) => setView(next === 'talk' ? 'talk' : next === 'converted' ? 'converted' : 'calls'),
      }}
      renderChart={() =>
        tokens ? <TelecallersPlot ranked={ranked} view={view} tokens={tokens} calls={calls} /> : null
      }
      renderTable={() => (
        <DataTable
          rows={ranked}
          rowKey={(row) => row.userId}
          columns={columns}
          minWidth="48rem"
          caption="The busiest telecallers in this period"
        />
      )}
      caption={caption}
      link={{ label: 'Full comparison in Reports', to: { section: 'reports', params: {} } }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The grid                                                                   */
/* -------------------------------------------------------------------------- */

export type ChartDataState = 'loading' | 'refetching' | 'ready' | 'failed';

export type DashboardAnalyticsResult = {
  data: DashboardAnalytics;
  /** The range as it was asked for — the follow-up donut's slices open exactly this. */
  request: DateRange;
  preset: RangePreset;
};

/**
 * The six trend cards.
 *
 * Five come from the analytics request and one (Telecallers) from the dashboard's own
 * per-employee rows, so either request can fail without taking the other's charts with
 * it. While either is refetching, the charts on screen stay where they are, dimmed, rather
 * than blanking into skeletons — the reader keeps their place, and nothing jumps.
 */
export function DashboardCharts({
  analytics,
  analyticsState,
  analyticsError,
  onRetryAnalytics,
  rows,
  rowsPreset,
  rowsState,
  onWiden,
}: {
  analytics: DashboardAnalyticsResult | null;
  analyticsState: ChartDataState;
  analyticsError: string | null;
  onRetryAnalytics: () => void;
  /** Per-employee figures from the dashboard request, for the Telecallers chart. */
  rows: EmployeePerformance[] | null;
  /** The preset `rows` were counted for. */
  rowsPreset: RangePreset;
  rowsState: ChartDataState;
  /** Switches the dashboard to the last 90 days. Absent when it already shows that or more. */
  onWiden?: () => void;
}) {
  const tokens = useChartTokens();
  const data = analytics?.data ?? null;
  const analyticsLeads = analytics ? leadsWindow(analytics.preset) : {};
  const rowsCalls = callsWindow(rowsPreset);
  const busy = analyticsState === 'refetching' || rowsState === 'refetching';
  const analyticsAvailable = analyticsState !== 'failed';

  return (
    <div className="tc-charts">
      {analyticsError ? (
        <FormAlert variant="error">
          {analytics ? 'The charts could not be updated. ' : 'The charts could not be loaded. '}
          {analyticsError}{' '}
          <button type="button" className="tc-alert-action" onClick={onRetryAnalytics}>
            Try again
          </button>
        </FormAlert>
      ) : null}

      <LoadingOverlay busy={busy} label="Updating the charts…">
        <div className="tc-chart-grid">
          {analyticsAvailable ? (
            <>
              <CallsCard data={data} tokens={tokens} onWiden={onWiden} />
              <TalkTimeCard data={data} tokens={tokens} />
              <FollowUpsCard data={data} request={analytics?.request ?? {}} tokens={tokens} />
              <LeadsByStatusCard data={data} tokens={tokens} window={analyticsLeads} />
              <LeadTrendCard data={data} tokens={tokens} window={analyticsLeads} />
            </>
          ) : null}

          {rowsState !== 'failed' ? <TelecallersCard rows={rows} tokens={tokens} calls={rowsCalls} /> : null}
        </div>
      </LoadingOverlay>
    </div>
  );
}
