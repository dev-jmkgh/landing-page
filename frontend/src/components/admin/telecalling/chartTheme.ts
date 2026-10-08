import { useEffect, useState } from 'react';
import type { ApexOptions } from './ApexChart';

/**
 * The look shared by every dashboard chart, and the rules that keep it safe.
 *
 * Colours come from the design tokens at runtime rather than from hex values in the chart
 * code, so a chart and the tile beside it can never drift apart, and a token change
 * reaches both.
 *
 * THE PALETTE, as validated with the dataviz palette checker on the white admin surface:
 *
 *   series1  --admin-brand  #0369a1   the primary series of every chart
 *   series2  --accent-500   #c08b2e   the second series (incoming calls, conversions)
 *   context  --ink-400      #94a3b8   de-emphasis grey — "not answered", "cancelled"
 *
 *   series1 + series2 pass every check (colour-blind ΔE 24.3, normal 29.6).
 *   series1 + context pass the distance checks, but the grey is only 2.56:1 against
 *   white. That is deliberate — it is the colour for "the rest" — and it is why every
 *   chart that uses it carries a legend, a tooltip and a table view: the grey is never
 *   the only way to tell what a mark is.
 *
 *   Follow-up status, in this fixed order: Completed --success-600, Overdue
 *   --danger-600, Not yet due --info-600, Cancelled --ink-400. Worst adjacent pair
 *   ΔE 9.1 (colour-blind), above the 8 floor.
 *
 *   Rejected: --navy-500 (too grey to read as a colour); brand blue next to success green
 *   (ΔE 13.1, below the 15 floor — never stack or adjoin them); warning orange next to
 *   danger red (ΔE 3.9 for deuteranopia — never put a late-orange slice beside red).
 *
 * UNTRUSTED TEXT. ApexCharts writes tooltip titles, tooltip rows and legend labels into
 * the page as HTML. Employee names come from self-registration, so a name is input from
 * outside, and `<img src=x onerror=…>` as a name would run in an administrator's session
 * the moment someone hovered the bar. Every chart here therefore draws its tooltip with
 * `tooltipHtml`, which escapes everything it is given, and passes legend text through
 * `escapeHtml`.
 *
 * A custom tooltip is NOT enough on its own: the library still writes its default title —
 * the raw x value, an employee name on the Telecallers chart — into a detached title
 * element with innerHTML on every hover, and a parsed `<img onerror>` runs even though
 * nothing shows. `baseOptions` turns that title off (`tooltip.x.show: false`); every chart
 * draws its own escaped title in `custom`. Do not turn it back on.
 *
 * Axis labels are the exception: the library draws those as SVG text nodes, which are
 * never parsed, so escaping them would show a literal "&amp;".
 */

export type ChartTokens = {
  series1: string;
  series2: string;
  context: string;
  good: string;
  critical: string;
  info: string;
  text: string;
  textMuted: string;
  grid: string;
  axis: string;
  surface: string;
  font: string;
};

/**
 * Token → role. The fallback is each token's value from tokens.css and pages.css, used
 * only if the stylesheet somehow did not load — a chart in the right colours beats a
 * chart in none.
 */
const TOKEN_ROLES: Record<Exclude<keyof ChartTokens, 'font'>, { token: string; fallback: string }> = {
  series1: { token: '--admin-brand', fallback: '#0369a1' },
  series2: { token: '--accent-500', fallback: '#c08b2e' },
  context: { token: '--ink-400', fallback: '#94a3b8' },
  good: { token: '--success-600', fallback: '#17795e' },
  critical: { token: '--danger-600', fallback: '#b42318' },
  info: { token: '--info-600', fallback: '#175cd3' },
  text: { token: '--ink-700', fallback: '#334155' },
  textMuted: { token: '--ink-500', fallback: '#64748b' },
  grid: { token: '--line-100', fallback: '#e8eff6' },
  axis: { token: '--line-200', fallback: '#d5e3ef' },
  surface: { token: '--surface', fallback: '#ffffff' },
};

/** Reads the tokens off the document. Browser only. */
export function readChartTokens(): ChartTokens {
  const root = getComputedStyle(document.documentElement);
  const tokens = {} as ChartTokens;

  for (const [role, { token, fallback }] of Object.entries(TOKEN_ROLES)) {
    const value = root.getPropertyValue(token).trim();
    tokens[role as keyof typeof TOKEN_ROLES] = value || fallback;
  }

  // The admin's body font, so chart text matches the tiles around it.
  tokens.font = getComputedStyle(document.body).fontFamily || 'sans-serif';
  return tokens;
}

/**
 * The chart tokens, read once after mount.
 *
 * Null on the first render: tokens live in the browser's computed styles, and reading
 * them during render would differ between the static prerender and the browser. The
 * charts show their skeletons for that one frame.
 */
export function useChartTokens(): ChartTokens | null {
  const [tokens, setTokens] = useState<ChartTokens | null>(null);

  useEffect(() => {
    setTokens(readChartTokens());
  }, []);

  return tokens;
}

/** Whether the person has asked their system for less motion. Browser only. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text made safe to place inside HTML — see UNTRUSTED TEXT above. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * A colour safe to put in a style attribute: a hex value or an rgb()/rgba() call, which
 * is all the tokens produce. Anything else becomes the muted grey rather than reaching
 * the markup.
 */
function safeColour(value: string | undefined): string {
  if (!value) return 'currentColor';
  return /^#[0-9a-f]{3,8}$/i.test(value) || /^rgba?\([\d\s.,%]+\)$/i.test(value) ? value : 'currentColor';
}

export type TooltipRow = {
  /** The series colour, drawn as a short line key beside the value. */
  colour?: string;
  label: string;
  value: string;
  /** A quieter aside after the label, e.g. "(71%)". */
  note?: string;
};

/**
 * A chart tooltip as HTML, with every piece of text escaped.
 *
 * Laid out value first and series name second — the reverse of a legend, because the
 * reader of a tooltip already knows the series and wants the number — and keyed with a
 * short stroke of the series colour rather than a filled box, which at this size is ink
 * doing a label's job.
 */
export function tooltipHtml({
  title,
  rows,
  footer,
}: {
  title: string;
  rows: TooltipRow[];
  footer?: string;
}): string {
  const body = rows
    .map(
      (row) =>
        `<div class="tc-tip__row">` +
        (row.colour
          ? `<span class="tc-tip__key" style="background-color:${safeColour(row.colour)}"></span>`
          : `<span class="tc-tip__key tc-tip__key--none"></span>`) +
        `<span class="tc-tip__value">${escapeHtml(row.value)}</span>` +
        `<span class="tc-tip__label">${escapeHtml(row.label)}` +
        (row.note ? ` <span class="tc-tip__note">${escapeHtml(row.note)}</span>` : '') +
        `</span></div>`,
    )
    .join('');

  return (
    `<div class="tc-tip">` +
    `<div class="tc-tip__title">${escapeHtml(title)}</div>` +
    body +
    (footer ? `<div class="tc-tip__foot">${escapeHtml(footer)}</div>` : '') +
    `</div>`
  );
}

/**
 * The options every chart starts from: recessive axes and grid, no toolbar or zoom, the
 * light theme set explicitly (the admin has no dark theme), and no animation for anyone
 * who has asked for less motion.
 *
 * Each chart layers its own options on top. These are plain objects, so a chart's
 * `chart`, `xaxis` or `yaxis` must spread the base's rather than replace it — see
 * `mergeChartOptions`.
 */
export function baseOptions(tokens: ChartTokens): ApexOptions {
  const motion = !prefersReducedMotion();
  const axisText = { colors: tokens.textMuted, fontSize: '12px', fontFamily: tokens.font };

  return {
    chart: {
      toolbar: { show: false },
      zoom: { enabled: false },
      selection: { enabled: false },
      background: 'transparent',
      foreColor: tokens.textMuted,
      fontFamily: tokens.font,
      redrawOnParentResize: true,
      redrawOnWindowResize: true,
      parentHeightOffset: 0,
      animations: {
        enabled: motion,
        speed: 300,
        animateGradually: { enabled: false },
        dynamicAnimation: { enabled: motion, speed: 250 },
      },
    },
    theme: { mode: 'light' },
    grid: {
      borderColor: tokens.grid,
      // Solid hairlines. A dashed grid reads as a projection or a threshold.
      strokeDashArray: 0,
      xaxis: { lines: { show: false } },
      yaxis: { lines: { show: true } },
      padding: { top: 0, right: 8, bottom: 0, left: 8 },
    },
    dataLabels: { enabled: false },
    states: {
      hover: { filter: { type: 'darken' } },
      // A click opens a list; there is no selected state to show.
      active: { filter: { type: 'none' } },
    },
    legend: {
      show: true,
      position: 'top',
      horizontalAlign: 'left',
      fontSize: '12px',
      fontFamily: tokens.font,
      offsetX: 0,
      offsetY: 0,
      labels: { colors: tokens.textMuted },
      markers: { size: 5, strokeWidth: 0, shape: 'square' },
      itemMargin: { horizontal: 10, vertical: 2 },
      // Clicking a legend entry would hide a series, and the tooltip, the table and the
      // list a bar opens would then disagree with what is drawn.
      onItemClick: { toggleDataSeries: false },
      onItemHover: { highlightDataSeries: true },
      formatter: (name: string) => escapeHtml(name),
    },
    tooltip: {
      theme: 'light',
      style: { fontSize: '12px', fontFamily: tokens.font },
      // The library's own title is written with innerHTML from the raw x value (an employee
      // name on the Telecallers chart), even beside a custom tooltip. Off, always: each
      // chart draws its own escaped title. See UNTRUSTED TEXT above.
      x: { show: false },
    },
    xaxis: {
      axisBorder: { show: true, color: tokens.axis },
      axisTicks: { show: false },
      labels: { style: axisText, rotate: 0, hideOverlappingLabels: true, trim: false },
      // The axis tooltip is another innerHTML sink, and the chart tooltip already names the
      // bucket.
      tooltip: { enabled: false },
      crosshairs: { show: false },
    },
    yaxis: {
      labels: { style: axisText },
      axisBorder: { show: false },
      axisTicks: { show: false },
      tooltip: { enabled: false },
    },
  };
}

/**
 * Lays a chart's own options over the base, one level deep for the sections where both
 * set keys — so a chart that sets `chart.type` keeps the base's toolbar and fonts.
 */
export function mergeChartOptions(base: ApexOptions, own: ApexOptions): ApexOptions {
  const merged: ApexOptions = { ...base, ...own };

  for (const key of ['chart', 'grid', 'legend', 'tooltip', 'states', 'dataLabels', 'plotOptions'] as const) {
    const baseValue = base[key];
    const ownValue = own[key];
    if (baseValue && ownValue) {
      (merged as Record<string, unknown>)[key] = { ...baseValue, ...ownValue };
    }
  }

  // Axes are merged a level deeper, because a chart that only changes its labels'
  // formatter should not lose the base's label colours.
  const xBase = base.xaxis ?? {};
  const xOwn = own.xaxis ?? {};
  merged.xaxis = { ...xBase, ...xOwn, labels: { ...xBase.labels, ...xOwn.labels } };

  const yBase = Array.isArray(base.yaxis) ? {} : (base.yaxis ?? {});
  if (Array.isArray(own.yaxis)) {
    merged.yaxis = own.yaxis.map((axis) => ({ ...yBase, ...axis, labels: { ...yBase.labels, ...axis.labels } }));
  } else {
    const yOwn = own.yaxis ?? {};
    merged.yaxis = { ...yBase, ...yOwn, labels: { ...yBase.labels, ...yOwn.labels } };
  }

  return merged;
}
