import { createHash } from 'node:crypto';
import { displaySymbol, formatPrice, formatTradeDate, sourceLabel } from '../../services/email';
import { escapeHtml } from '../../utils/text';
import type { BreakoutRecord, DayRecord, PageSlice } from './stockbot.repository';
import { isWeekday, marketTimes, type FrozenLevel } from './stockbot.schema';

/**
 * The trader's status page: one day's state, levels and breakouts, read-only.
 *
 * The trader has no account in any JMK app, so the page is reached by a private link and
 * rendered here as plain HTML — no frontend build, no JavaScript. It is read on a phone,
 * so it is one narrow column whose tables scroll sideways. Every list is a server-side
 * page of PAGE_SIZE rows. Today's page reloads itself once a minute while the market is
 * open (a meta refresh: the API's CSP allows no script).
 *
 * The stylesheet is one fixed string, allowed by its hash in the route's CSP, so the
 * page carries no inline style attributes.
 */

export const PAGE_SIZE = 50;
const REFRESH_SECONDS = 60;

const CSS = `
:root{--ink:#0a1b2e;--muted:#5b6b7c;--line:#e3e8ee;--panel:#f5f7fa;--good:#137a3f;--good-soft:#e8f5ee;--warn:#9a6200;--warn-soft:#fdf4e3;--bad:#b42318;--bad-soft:#fdecea;--accent:#c9a227}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}
h1{margin:0;font-size:20px}
h2{margin:28px 0 8px;font-size:13px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
a{color:var(--ink)}
.day{margin:2px 0 12px;color:var(--muted)}
.days{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}
.days a,.pager a,button{display:inline-block;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);text-decoration:none;font:inherit;font-size:14px;cursor:pointer}
form{display:flex;gap:8px;margin:0}
input{padding:6px 10px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:14px;min-width:0}
.status{padding:12px 14px;border-left:4px solid var(--accent);border-radius:6px;background:var(--panel)}
.status strong{display:block}
.status span{color:var(--muted);font-size:14px}
.status.good{border-color:var(--good);background:var(--good-soft)}
.status.warn{border-color:var(--warn);background:var(--warn-soft)}
.status.bad{border-color:var(--bad);background:var(--bad-soft)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:12px 0 0;padding:0}
.tiles div{padding:10px 12px;border:1px solid var(--line);border-radius:6px}
.tiles dt{color:var(--muted);font-size:12px}
.tiles dd{margin:0;font-size:20px;font-weight:600}
.search{margin-top:20px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:6px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{position:sticky;top:0;background:var(--panel);text-align:left;font-size:12px;color:var(--muted);font-weight:600}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td .sub{display:block;color:var(--muted);font-size:12px}
.up{color:var(--good);font-weight:600}
.down{color:var(--bad);font-weight:600}
.none{color:var(--muted)}
.empty{padding:14px;color:var(--muted)}
.pager{display:flex;gap:8px;align-items:center;margin-top:8px;color:var(--muted);font-size:14px}
td.none{white-space:normal}
footer{margin:32px 0 8px;color:var(--muted);font-size:13px}
@media (max-width:520px){
th,td{padding:7px 6px;font-size:13px}
.opt{display:none}
td.stock{white-space:normal;overflow-wrap:anywhere;max-width:9.5rem}
}
`.trim();

/** For the route's Content-Security-Policy: this stylesheet and nothing else. */
export const PAGE_STYLE_HASH = `sha256-${createHash('sha256').update(CSS).digest('base64')}`;

const TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export type StatusPageData = {
  tradeDate: string;
  today: string;
  now: Date;
  day: DayRecord | null;
  adjacent: { previous: string | null; next: string | null };
  search: string | null;
  levels: PageSlice<FrozenLevel>;
  levelsPage: number;
  breakouts: PageSlice<BreakoutRecord>;
  breakoutsPage: number;
};

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** What the day's row means to someone who has never seen the database. */
function describeDay(data: StatusPageData): { tone: Tone; headline: string; detail: string } {
  const { day, tradeDate, today, now } = data;
  const times = marketTimes(tradeDate);
  const isToday = tradeDate === today;

  if (!day) {
    if (!isWeekday(tradeDate)) return { tone: 'neutral', headline: 'Market closed', detail: 'Weekend.' };
    if (isToday && now < times.sessionStart) {
      return { tone: 'neutral', headline: 'Starts at 09:00 IST', detail: 'Levels are set at 09:15:30.' };
    }
    if (isToday) {
      return { tone: 'bad', headline: 'Not running', detail: 'The bot has not started today. Tell the JMK team.' };
    }
    return { tone: 'neutral', headline: 'No session', detail: 'The bot did not run on this day.' };
  }

  switch (day.status) {
    case 'starting':
      return day.lastError
        ? { tone: 'warn', headline: 'Starting — retrying', detail: day.lastError }
        : { tone: 'neutral', headline: 'Starting', detail: 'Logging in and preparing the list of stocks.' };
    case 'capturing':
      return { tone: 'neutral', headline: 'Recording the opening range', detail: 'Levels are set at 09:15:30.' };
    case 'monitoring':
      return isToday && now < times.close
        ? { tone: 'good', headline: 'Live — watching for breakouts', detail: 'Levels are set. Breakouts appear below as they happen.' }
        : { tone: 'warn', headline: 'Stopped before the close', detail: 'Breakouts after the stop were not recorded.' };
    case 'closed':
      return { tone: 'good', headline: 'Closed for the day', detail: 'Ran from the open to 15:30.' };
    case 'no_data':
      return {
        tone: 'warn',
        headline: 'No market data',
        detail: 'Nothing traded between 09:15:00 and 09:15:30 — usually an exchange holiday.',
      };
    case 'missed':
      return { tone: 'bad', headline: 'No levels today', detail: 'The bot was not running at 09:15, so there is no opening range.' };
    case 'failed':
      return { tone: 'bad', headline: 'Did not run', detail: day.lastError ?? 'Stopped for the day.' };
    default:
      return { tone: 'neutral', headline: day.status, detail: '' };
  }
}

/** Is this page worth reloading by itself? Only today's, while something can change. */
function isLive(data: StatusPageData): boolean {
  if (data.tradeDate !== data.today || !isWeekday(data.tradeDate)) return false;
  const times = marketTimes(data.tradeDate);
  const now = data.now.getTime();
  return now >= times.sessionStart.getTime() - 5 * 60_000 && now < times.close.getTime() + 5 * 60_000;
}

/** A link to this page with some parameters changed. Relative, so the token stays in the path. */
function href(data: StatusPageData, changes: { date?: string; lp?: number; bp?: number; q?: string | null }): string {
  const params = new URLSearchParams();
  const date = changes.date ?? data.tradeDate;
  if (date !== data.today) params.set('date', date);
  const q = changes.q === undefined ? data.search : changes.q;
  if (q) params.set('q', q);
  const lp = changes.lp ?? (changes.date ? 1 : data.levelsPage);
  const bp = changes.bp ?? (changes.date ? 1 : data.breakoutsPage);
  if (lp > 1) params.set('lp', String(lp));
  if (bp > 1) params.set('bp', String(bp));
  const query = params.toString();
  return query ? `?${escapeHtml(query)}` : '?';
}

function pager(data: StatusPageData, total: number, page: number, key: 'lp' | 'bp'): string {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages === 1) return '';
  const to = (target: number) => href(data, key === 'lp' ? { lp: target } : { bp: target });
  const previous = page > 1 ? `<a href="${to(page - 1)}">← Previous</a>` : '';
  const next = page < pages ? `<a href="${to(page + 1)}">Next →</a>` : '';
  return `<div class="pager">${previous}<span>Page ${page} of ${pages}</span>${next}</div>`;
}

function breakoutsTable(data: StatusPageData): string {
  const { items, total } = data.breakouts;
  if (total === 0) {
    return `<div class="scroll"><p class="empty">${data.search ? 'No breakouts match.' : 'No breakouts yet.'}</p></div>`;
  }
  const rows = items
    .map(
      (item) => `<tr>
<td>${escapeHtml(TIME.format(item.detectedAt))}</td>
<td class="stock">${escapeHtml(displaySymbol(item.symbol))}<span class="sub">${escapeHtml(item.exchange)}</span></td>
<td class="${item.direction}">${item.direction === 'up' ? 'Above high' : 'Below low'}</td>
<td class="num">${formatPrice(item.level)}</td>
<td class="num">${formatPrice(item.price)}</td>
<td class="num opt">${formatPrice(item.lastPrice)}</td>
</tr>`,
    )
    .join('');
  // On a phone the "Last" column is dropped (.opt): the level and the price that crossed
  // it are what matter at a glance.
  return `<div class="scroll"><table>
<thead><tr><th>Time (IST)</th><th>Stock</th><th>Break</th><th class="num">Level</th><th class="num">Traded</th><th class="num opt">Last</th></tr></thead>
<tbody>${rows}</tbody></table></div>${pager(data, total, data.breakoutsPage, 'bp')}`;
}

function levelsTable(data: StatusPageData): string {
  const { items, total } = data.levels;
  if (total === 0) {
    return `<div class="scroll"><p class="empty">${data.search ? 'No stock matches.' : 'Levels are set at 09:15:30.'}</p></div>`;
  }
  const rows = items
    .map((level) => {
      const width = level.high !== null && level.low !== null ? formatPrice(level.high - level.low) : '—';
      return `<tr>
<td class="stock">${escapeHtml(displaySymbol(level.symbol))}<span class="sub">${escapeHtml(level.exchange)} · ${escapeHtml(sourceLabel(level.sources))}</span></td>
${
  level.status === 'ok'
    ? `<td class="num">${formatPrice(level.high)}</td><td class="num">${formatPrice(level.low)}</td><td class="num opt">${width}</td>`
    : '<td class="none" colspan="3">No trade in the window — not watched today</td>'
}
</tr>`;
    })
    .join('');
  return `<div class="scroll"><table>
<thead><tr><th>Stock</th><th class="num">High</th><th class="num">Low</th><th class="num opt">Width</th></tr></thead>
<tbody>${rows}</tbody></table></div>${pager(data, total, data.levelsPage, 'lp')}`;
}

export function renderStatusPage(data: StatusPageData): string {
  const { day, adjacent, tradeDate } = data;
  const status = describeDay(data);
  const live = isLive(data);
  const dayLabel = formatTradeDate(tradeDate);
  const tile = (label: string, value: number | null | undefined) =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${value ?? '—'}</dd></div>`;

  const dayLinks = [
    adjacent.previous ? `<a href="${href(data, { date: adjacent.previous })}">← ${escapeHtml(formatTradeDate(adjacent.previous))}</a>` : '',
    `<form method="get"><input type="date" name="date" value="${escapeHtml(tradeDate)}" aria-label="Day"><button type="submit">Go</button></form>`,
    adjacent.next ? `<a href="${href(data, { date: adjacent.next })}">${escapeHtml(formatTradeDate(adjacent.next))} →</a>` : '',
    tradeDate !== data.today ? `<a href="${href(data, { date: data.today, q: null })}">Today</a>` : '',
  ].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${live ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` : ''}
<title>Breakout levels · ${escapeHtml(dayLabel)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Breakout levels</h1>
<p class="day">${escapeHtml(dayLabel)}</p>
<nav class="days">${dayLinks}</nav>

<section class="status ${status.tone}"><strong>${escapeHtml(status.headline)}</strong><span>${escapeHtml(status.detail)}</span></section>
<dl class="tiles">
${tile('Stocks tracked', day?.targetCount)}
${tile('Levels set', day?.levelsOk)}
${tile('No trade 09:15:00–09:15:30', day?.levelsMissing)}
${tile('Breakouts', data.search ? null : data.breakouts.total)}
</dl>

<form class="search" method="get">
${tradeDate !== data.today ? `<input type="hidden" name="date" value="${escapeHtml(tradeDate)}">` : ''}
<input type="search" name="q" value="${escapeHtml(data.search ?? '')}" placeholder="Find a stock" aria-label="Find a stock" maxlength="20">
<button type="submit">Find</button>
${data.search ? `<a href="${href(data, { q: null, lp: 1, bp: 1 })}">Clear</a>` : ''}
</form>

<h2>Breakouts${data.breakouts.total ? ` (${data.breakouts.total})` : ''} — newest first</h2>
${breakoutsTable(data)}

<h2>Levels${data.levels.total ? ` (${data.levels.total})` : ''}</h2>
${levelsTable(data)}

<footer>
Level = the high and low traded between 09:15:00 and 09:15:30 IST. A breakout is the first trade above the high or below the low; each is shown once a day. Alerts only — no orders are placed.<br>
Updated ${escapeHtml(TIME.format(data.now))} IST${live ? ' · refreshes every minute while the market is open' : ''}.
</footer>
</main>
</body>
</html>`;
}
