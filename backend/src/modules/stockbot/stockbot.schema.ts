import { z } from 'zod';
import { COMPANY_UTC_OFFSET } from '../telecalling/companyTime';

/**
 * Vocabulary shared by the opening-range breakout bot.
 *
 * The strategy, in one paragraph: every trading day, for every stock in the client's
 * holdings and watchlists, take the high and the low traded between 09:15:00 and
 * 09:15:30 IST, freeze them as that day's levels, and report the first trade above the
 * high and the first below the low until the close. Alerts only — nothing here places an
 * order.
 */

export const EXCHANGES = ['NSE', 'BSE'] as const;
export type Exchange = (typeof EXCHANGES)[number];

/**
 * SmartStream's numeric exchange segments for the two cash markets. The feed speaks in
 * these; everything else in the bot speaks in `Exchange`.
 */
export const EXCHANGE_TYPE: Record<Exchange, number> = { NSE: 1, BSE: 3 };
export const EXCHANGE_BY_TYPE: ReadonlyMap<number, Exchange> = new Map([
  [1, 'NSE'],
  [3, 'BSE'],
]);

/* -------------------------------------------------------------------------- */
/* Market clock (IST)                                                          */
/* -------------------------------------------------------------------------- */

/** When a session starts: login, instruments and the subscription all need to be done
 *  before the bell, with room for a retry or two. */
export const SESSION_START = '09:00:00';
/** The opening range: [09:15:00, 09:15:30), by exchange timestamp. */
export const RANGE_START = '09:15:00';
export const RANGE_END = '09:15:30';
/**
 * How long after RANGE_END (by our clock) the levels are frozen. Packets arrive a little
 * after the exchange stamps them; anything stamped inside the window but delivered within
 * this grace still counts. Packets are placed by their exchange timestamp, never by when
 * they arrived, so the grace only bounds how long to wait.
 */
export const FREEZE_GRACE_MS = 3_000;
/** Normal market close. The session ends here. */
export const MARKET_CLOSE = '15:30:00';

/** An IST wall-clock time with seconds on an IST date, as an instant. */
export function marketInstant(tradeDate: string, hhmmss: string): Date {
  return new Date(`${tradeDate}T${hhmmss}${COMPANY_UTC_OFFSET}`);
}

export type MarketTimes = {
  sessionStart: Date;
  rangeStart: Date;
  rangeEnd: Date;
  freezeAt: Date;
  close: Date;
};

export function marketTimes(tradeDate: string): MarketTimes {
  const rangeEnd = marketInstant(tradeDate, RANGE_END);
  return {
    sessionStart: marketInstant(tradeDate, SESSION_START),
    rangeStart: marketInstant(tradeDate, RANGE_START),
    rangeEnd,
    freezeAt: new Date(rangeEnd.getTime() + FREEZE_GRACE_MS),
    close: marketInstant(tradeDate, MARKET_CLOSE),
  };
}

/**
 * Monday to Friday. Exchange holidays are not listed here: on a holiday nothing trades
 * in the window, the day ends as `no_data`, and the administrators get one notice — the
 * same outcome a dead feed would have, which is the case worth hearing about.
 */
export function isWeekday(tradeDate: string): boolean {
  const day = new Date(`${tradeDate}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

/* -------------------------------------------------------------------------- */
/* Instruments and targets                                                     */
/* -------------------------------------------------------------------------- */

export type Instrument = {
  exchange: Exchange;
  token: string;
  /** Trading symbol: `RELIANCE-EQ` on NSE, `RELIANCE` on BSE. */
  symbol: string;
  /** Underlying name: `RELIANCE`. */
  name: string;
  isIndex: boolean;
};

/** One instrument the bot tracks today, and every list that asked for it. */
export type Target = {
  instrument: Instrument;
  sources: Set<string>;
};

export const HOLDINGS_SOURCE = 'holdings';
export const WATCHLIST_SOURCE_PREFIX = 'watchlist:';

export function instrumentKey(exchange: Exchange, token: string): string {
  return `${exchange}:${token}`;
}

/**
 * `watchlists.json` in the data directory. SmartAPI has no watchlist endpoint, so this
 * file mirrors the client's watchlists by hand. It is read afresh every morning, so an
 * edit takes effect the next trading day without a restart.
 *
 *   { "watchlists": { "Watchlist 1": ["RELIANCE", "TCS", "BSE:SBIN"] } }
 */
export const watchlistFileSchema = z.object({
  watchlists: z.record(z.string().min(1).max(60), z.array(z.string().trim().min(1).max(40)).max(1000)),
});
export type WatchlistFile = z.infer<typeof watchlistFileSchema>;

/* -------------------------------------------------------------------------- */
/* Feed packets, levels, breakouts                                             */
/* -------------------------------------------------------------------------- */

/**
 * One SmartStream market-data packet, decoded. Prices are rupees. `dayHigh`/`dayLow` are
 * the exchange's own cumulative figures for the day, present in QUOTE mode, and they are
 * what make the bot exact: a trade between two packets still moves them.
 */
export type QuotePacket = {
  exchange: Exchange;
  token: string;
  /**
   * When the feed stamped the packet. NOT necessarily a trade: on a Saturday the feed
   * sends packets stamped that morning that still carry Friday's prices.
   */
  exchangeTime: Date;
  /**
   * When the instrument last traded (SNAP_QUOTE only; null otherwise). The only field
   * that proves a packet's prices are from today's session.
   */
  lastTradeTime: Date | null;
  lastPrice: number;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
};

export type LevelStatus = 'ok' | 'no_data';

export type FrozenLevel = {
  exchange: Exchange;
  token: string;
  symbol: string;
  sources: string[];
  status: LevelStatus;
  high: number | null;
  low: number | null;
  open: number | null;
  packetAt: Date | null;
};

export type BreakoutDirection = 'up' | 'down';

export type BreakoutEvent = {
  exchange: Exchange;
  token: string;
  symbol: string;
  direction: BreakoutDirection;
  level: number;
  /** The day high (up) or day low (down) that crossed the level. */
  price: number;
  lastPrice: number;
  detectedAt: Date;
};

export const DAY_STATUSES = [
  'starting',
  'capturing',
  'monitoring',
  'closed',
  'no_data',
  'missed',
  'failed',
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

/** Statuses after which nothing more happens that day. */
export const FINAL_DAY_STATUSES: readonly DayStatus[] = ['closed', 'no_data', 'missed', 'failed'];
