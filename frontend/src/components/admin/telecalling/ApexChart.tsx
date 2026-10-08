'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
// Types only: erased at build time, so this line loads nothing. The library itself is
// reached through `loadApexCharts` below and nowhere else.
import type ApexChartsT from 'apexcharts';

export type ApexOptions = ApexChartsT.ApexOptions;

type ApexChartsClass = typeof ApexChartsT;

/**
 * The library, loaded once for the whole page.
 *
 * Six charts share this one promise, so the chunk is fetched once however many mount at
 * the same moment. It is created the first time a chart mounts — never during the static
 * prerender, where the library cannot run (see apexBundle.ts) — and forgotten again if the
 * chunk fails to load, so "Try again" makes a fresh attempt rather than replaying the
 * failure.
 */
let bundle: Promise<ApexChartsClass> | null = null;

export function loadApexCharts(): Promise<ApexChartsClass> {
  if (!bundle) {
    bundle = import('./apexBundle')
      .then((module) => module.default)
      .catch((error: unknown) => {
        bundle = null;
        throw error;
      });
  }
  return bundle;
}

/**
 * What a click landed on: the data point's index, and its series when the click was on a
 * particular mark (a bar segment, a slice, a marker). `seriesIndex` is null for a click on
 * a series as a whole — the area of an area chart — where the point comes from the
 * pointer's position.
 */
export type ChartHit = { seriesIndex: number | null; dataPointIndex: number };

/** A non-negative whole number from an attribute or the library's event config, or null. */
function toIndex(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * Reads the mark under a click.
 *
 * Bars, slices and markers carry their series and point as `index` and `j` attributes. A
 * click elsewhere inside a series — the fill of an area chart — takes the point the
 * tooltip is showing. Anything outside the series (the legend, an axis label, the empty
 * plot) is not a hit: those clicks would otherwise open whatever bucket the pointer last
 * passed over.
 */
function hitFrom(event: Event, config: { dataPointIndex?: unknown } | undefined): ChartHit | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;

  const mark = target.closest('[j]');
  if (mark && mark.closest('.apexcharts-series')) {
    const dataPointIndex = toIndex(mark.getAttribute('j'));
    if (dataPointIndex !== null) {
      return { seriesIndex: toIndex(mark.getAttribute('index')), dataPointIndex };
    }
  }

  if (target.closest('.apexcharts-series')) {
    const dataPointIndex = toIndex(config?.dataPointIndex);
    if (dataPointIndex !== null) return { seriesIndex: null, dataPointIndex };
  }

  return null;
}

/** How long after the library's mouseup/touchend the browser's click may arrive. */
const CLICK_WINDOW_MS = 1000;

/**
 * One ApexCharts chart, created when it mounts and destroyed when it unmounts.
 *
 * A local wrapper rather than react-apexcharts: that package imports the library at the
 * top of the module, which would put it in this route's main bundle (and break the static
 * export with 4.7.0); it only supports the licensed 5.x line; and it deep-compares the
 * options on every render. This one is short and does four things:
 *
 * - Loads the library on demand, and shows a skeleton of the chart's own height until
 *   the first render is on screen, so nothing shifts when it lands.
 * - Is safe under React's development double-mount: a load that resolves after its
 *   effect was cleaned up creates nothing, and a chart is destroyed only once its first
 *   render has settled.
 * - Updates in place when `options` change, rather than rebuilding. The caller must
 *   memoise `options`; a new object on every render would redraw on every render.
 * - Turns clicks into `onPointClick(hit)` — see the click note below.
 *
 * When a table view replaces the chart, unmount the chart rather than hiding it: the
 * library measures its container, and a hidden one measures zero.
 */
export function ApexChart({
  options,
  height,
  label,
  onPointClick,
}: {
  options: ApexOptions;
  height: number;
  /** A one-sentence summary of what the chart shows, for screen readers. */
  label: string;
  /** Present when a click on the chart opens something. Adds the clickable cursor. */
  onPointClick?: (hit: ChartHit) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ApexChartsT | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);

  const clickRef = useRef(onPointClick);
  useEffect(() => {
    clickRef.current = onPointClick;
  }, [onPointClick]);

  /*
   * Clicks.
   *
   * The library reports a click on mouseup and on touchend — including the touchend that
   * ends a finger scroll across the chart on a tablet, which would open a list in the
   * middle of scrolling. So its click event only records what was under the pointer, and
   * the browser's own click event, which follows a real tap or click but never a scroll,
   * is what acts on it.
   */
  const pendingHit = useRef<{ hit: ChartHit | null; at: number } | null>(null);

  const finalOptions = useMemo<ApexOptions>(
    () => ({
      ...options,
      chart: {
        ...options.chart,
        height,
        events: {
          ...options.chart?.events,
          click: (event: Event, _chart: unknown, config?: { dataPointIndex?: unknown }) => {
            pendingHit.current = { hit: hitFrom(event, config), at: Date.now() };
          },
        },
      },
    }),
    [options, height],
  );

  /** The newest options, for a chart created after they changed. */
  const optionsRef = useRef(finalOptions);
  /** The options the chart on screen was last given, so they are never applied twice. */
  const appliedRef = useRef<ApexOptions | null>(null);

  // Creates the chart. Re-runs only for "Try again" — everything else is an update.
  useEffect(() => {
    let cancelled = false;
    let instance: ApexChartsT | null = null;
    let firstRender: Promise<void> | null = null;

    setStatus('loading');

    loadApexCharts()
      .then((Apex) => {
        const host = hostRef.current;
        if (cancelled || !host) return undefined;

        const rendered = optionsRef.current;
        const chart = new Apex(host, rendered);
        instance = chart;
        chartRef.current = chart;
        firstRender = chart.render();

        return firstRender.then(() => {
          if (cancelled) return;
          appliedRef.current = rendered;
          // The update effect below catches up with anything that changed meanwhile.
          setStatus('ready');
        });
      })
      .catch(() => {
        if (!cancelled) setStatus('failed');
      });

    return () => {
      cancelled = true;
      chartRef.current = null;
      appliedRef.current = null;
      const chart = instance;
      if (!chart) return;
      // Destroying in the middle of the first render leaves the library's timers running
      // against nodes it has just removed, so wait for the render to settle first.
      void (firstRender ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => chart.destroy());
    };
  }, [attempt]);

  useEffect(() => {
    optionsRef.current = finalOptions;
    const chart = chartRef.current;
    if (status !== 'ready' || !chart || appliedRef.current === finalOptions) return;
    appliedRef.current = finalOptions;
    // Paths morph from the previous data rather than redrawing from the baseline.
    chart.updateOptions(finalOptions, false, true).catch(() => undefined);
  }, [finalOptions, status]);

  const onClick = () => {
    const pending = pendingHit.current;
    pendingHit.current = null;
    const handler = clickRef.current;
    if (!handler || !pending || !pending.hit || Date.now() - pending.at > CLICK_WINDOW_MS) return;
    handler(pending.hit);
  };

  return (
    <div
      className={onPointClick ? 'tc-apex tc-apex--clickable' : 'tc-apex'}
      style={{ minHeight: height }}
      onClick={onClick}
    >
      <div ref={hostRef} role="img" aria-label={label} />

      {status === 'loading' ? (
        <div className="skeleton tc-skeleton--chart tc-apex__cover" style={{ height }} aria-hidden="true" />
      ) : null}

      {status === 'failed' ? (
        <div className="tc-apex__cover tc-apex__failed" role="alert">
          <p>The chart could not be drawn. The table view shows the same figures.</p>
          <button type="button" className="btn btn--outline btn--sm" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
