import { renderEmail, renderText, type EmailDocument } from '../layout/base';
import {
  callout,
  dataTable,
  paragraph,
  sectionHeading,
  textTable,
  type CalloutTone,
  type DataCell,
  type DataColumn,
} from '../layout/components';

/**
 * The opening-range breakout bot's emails, all to ADMIN_EMAILS:
 *
 *  - levels    once each trading morning, just after 09:15:30: the frozen range per stock;
 *  - breakouts a digest at most once a minute while new breaks keep arriving;
 *  - notice    once on a day the bot could not run (holiday, no data, bad credentials).
 *
 * Read on a phone in the first minutes of the session, so the subject carries the
 * substance — symbols and directions — and the body is a table to glance at.
 */

const PRICE = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const DAY = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

export function formatPrice(value: number | null): string {
  return value === null ? '—' : PRICE.format(value);
}

/** `Fri, 23 Oct 2026` for a `YYYY-MM-DD` IST trading date. */
export function formatTradeDate(tradeDate: string): string {
  return DAY.format(new Date(`${tradeDate}T12:00:00+05:30`));
}

/** Without the NSE series suffix, which nobody says out loud: `RELIANCE-EQ` -> `RELIANCE`. */
function displaySymbol(symbol: string): string {
  return symbol.replace(/-(EQ|BE|BZ|SM|ST)$/, '');
}

/* -------------------------------------------------------------------------- */

export type StockbotLevelRow = {
  symbol: string;
  exchange: string;
  high: number | null;
  low: number | null;
  sources: string[];
};

export type StockbotLevelsEmailData = {
  tradeDate: string;
  levels: StockbotLevelRow[];
  /** Tracked but did not trade in the window: not watched today. */
  missing: { symbol: string; exchange: string }[];
  /** Watchlist entries that matched no instrument. */
  unresolved: string[];
};

const LEVEL_COLUMNS: readonly DataColumn[] = [
  { label: 'Stock' },
  { label: 'High', align: 'right' },
  { label: 'Low', align: 'right' },
  { label: 'Width', align: 'right' },
];

function sourceLabel(sources: readonly string[]): string {
  return sources.map((source) => source.replace(/^watchlist:/, '')).join(', ');
}

export function stockbotLevelsEmail(data: StockbotLevelsEmailData): EmailDocument {
  const day = formatTradeDate(data.tradeDate);
  const rows: DataCell[][] = data.levels.map((level) => [
    { text: displaySymbol(level.symbol), sub: `${level.exchange} · ${sourceLabel(level.sources)}` },
    formatPrice(level.high),
    formatPrice(level.low),
    level.high !== null && level.low !== null ? formatPrice(level.high - level.low) : '—',
  ]);

  const headline = `Opening range set for ${data.levels.length} stock${data.levels.length === 1 ? '' : 's'}`;
  const notes: string[] = [];
  if (data.missing.length > 0) {
    notes.push(
      `Not watched today (no trade between 09:15:00 and 09:15:30): ` +
        data.missing.map((item) => displaySymbol(item.symbol)).join(', '),
    );
  }
  if (data.unresolved.length > 0) {
    notes.push(`Watchlist entries that matched no stock: ${data.unresolved.join('; ')}`);
  }

  return {
    subject: `${headline} · ${day}`,
    html: renderEmail({
      title: 'Opening range set',
      preheader: `High and low between 09:15:00 and 09:15:30 IST, ${day}. Breakout alerts follow.`,
      content: [
        paragraph(
          `These are today's levels: the high and low traded between 09:15:00 and 09:15:30 IST. ` +
            'You will get an email when a stock trades above its high or below its low.',
        ),
        sectionHeading(headline),
        dataTable({ columns: LEVEL_COLUMNS, rows, emptyText: 'No stock traded in the window.' }),
        ...(notes.length > 0 ? [sectionHeading('Also'), callout('Worth knowing', notes, 'warn')] : []),
      ].join('\n'),
    }),
    text: renderText([
      `${headline} — ${day}`,
      'High and low traded between 09:15:00 and 09:15:30 IST.',
      '',
      ...textTable(LEVEL_COLUMNS, rows),
      ...(notes.length > 0 ? ['', ...notes] : []),
    ]),
  };
}

/* -------------------------------------------------------------------------- */

export type StockbotBreakoutRow = {
  symbol: string;
  exchange: string;
  direction: 'up' | 'down';
  level: number;
  price: number;
  lastPrice: number;
  detectedAt: Date;
};

const BREAKOUT_COLUMNS: readonly DataColumn[] = [
  { label: 'Time (IST)' },
  { label: 'Stock' },
  { label: 'Break' },
  { label: 'Level', align: 'right' },
  { label: 'Traded', align: 'right' },
  { label: 'Last', align: 'right' },
];

function breakLabel(direction: 'up' | 'down'): string {
  return direction === 'up' ? 'Above high' : 'Below low';
}

export function stockbotBreakoutsEmail(data: { tradeDate: string; breakouts: StockbotBreakoutRow[] }): EmailDocument {
  const rows: DataCell[][] = data.breakouts.map((item) => [
    TIME.format(item.detectedAt),
    { text: displaySymbol(item.symbol), sub: item.exchange },
    breakLabel(item.direction),
    formatPrice(item.level),
    formatPrice(item.price),
    formatPrice(item.lastPrice),
  ]);

  // The subject is what a phone shows: name the first few breaks outright.
  const named = data.breakouts
    .slice(0, 3)
    .map((item) => `${displaySymbol(item.symbol)} ${item.direction === 'up' ? 'above' : 'below'} ${formatPrice(item.level)}`);
  const more = data.breakouts.length - named.length;
  const subject = `Breakout: ${named.join(', ')}${more > 0 ? ` +${more} more` : ''}`;

  return {
    subject,
    html: renderEmail({
      title: data.breakouts.length === 1 ? 'Breakout' : `${data.breakouts.length} breakouts`,
      preheader: named.join(', '),
      content: [
        paragraph(
          'A stock traded beyond its opening range (09:15:00–09:15:30 IST). "Traded" is the ' +
            'price that crossed the level; "Last" is the price when it was seen. Each level is ' +
            'reported once a day.',
        ),
        dataTable({ columns: BREAKOUT_COLUMNS, rows }),
        paragraph(`Trading day: ${formatTradeDate(data.tradeDate)}.`, { muted: true, size: 13 }),
      ].join('\n'),
    }),
    text: renderText([subject, '', ...textTable(BREAKOUT_COLUMNS, rows)]),
  };
}

/* -------------------------------------------------------------------------- */

export function stockbotNoticeEmail(data: {
  tradeDate: string;
  heading: string;
  lines: string[];
  tone?: CalloutTone;
}): EmailDocument {
  const day = formatTradeDate(data.tradeDate);
  return {
    subject: `Stock bot: ${data.heading} · ${day}`,
    html: renderEmail({
      title: 'Stock bot',
      preheader: data.heading,
      content: callout(data.heading, data.lines, data.tone ?? 'warn'),
    }),
    text: renderText([`${data.heading} — ${day}`, '', ...data.lines]),
  };
}
