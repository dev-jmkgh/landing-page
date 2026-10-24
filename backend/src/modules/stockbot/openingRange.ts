import {
  instrumentKey,
  type BreakoutDirection,
  type BreakoutEvent,
  type FrozenLevel,
  type QuotePacket,
  type Target,
} from './stockbot.schema';

/**
 * The strategy itself, with no I/O: feed it packets, read levels and breakouts out.
 *
 * WHICH PACKETS COUNT is decided by the exchange timestamp, never by when a packet
 * arrived, so network delay cannot move a trade into or out of the window. And a packet
 * counts only if its last trade was today: the feed stamps snapshots with the time it
 * sends them, so on an exchange holiday a packet "inside the window" can carry the
 * previous session's high and low. Those days must end with no levels, not wrong ones.
 *
 * THE RANGE comes from the exchange's cumulative day high and low on the last packet
 * stamped inside [09:15:00, 09:15:30). Trading begins at 09:15:00, so at that moment the
 * day's high and low ARE the window's — including the opening price set by the pre-open
 * auction, exactly as a broker's 09:15 candle includes it. The highest and lowest last
 * prices seen in the window are folded in as well, which only matters if a packet ever
 * arrives without the day figures.
 *
 * The one imprecision is the feed's own: a trade in the last instant before 09:15:30
 * that no packet stamped inside the window reported will look like a breakout on the
 * first packet after it.
 */

type Seen = { last: QuotePacket; maxPrice: number | null; minPrice: number | null };

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function highest(...values: (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length > 0 ? Math.max(...usable) : null;
}

function lowest(...values: (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length > 0 ? Math.min(...usable) : null;
}

export class OpeningRangeCapture {
  private readonly seen = new Map<string, Seen>();

  /**
   * `tradedSince` is the start of today's session (09:00 IST, before the pre-open auction
   * trades). A packet whose last trade is older than that is a stale snapshot.
   */
  constructor(
    private readonly windowStart: Date,
    private readonly windowEnd: Date,
    private readonly tradedSince: Date,
  ) {}

  /** Records a packet if it was stamped inside the window with today's prices. Returns whether it counted. */
  add(packet: QuotePacket): boolean {
    const at = packet.exchangeTime.getTime();
    if (at < this.windowStart.getTime() || at >= this.windowEnd.getTime()) return false;
    // Unknown (a QUOTE-mode packet) is accepted: the field is absent, not old.
    if (packet.lastTradeTime && packet.lastTradeTime.getTime() < this.tradedSince.getTime()) return false;

    const key = instrumentKey(packet.exchange, packet.token);
    const price = positive(packet.lastPrice);
    const entry = this.seen.get(key);
    if (!entry) {
      this.seen.set(key, { last: packet, maxPrice: price, minPrice: price });
      return true;
    }
    if (at >= entry.last.exchangeTime.getTime()) entry.last = packet;
    entry.maxPrice = highest(entry.maxPrice, price);
    entry.minPrice = lowest(entry.minPrice, price);
    return true;
  }

  /** How many instruments have at least one packet in the window so far. */
  get instrumentsSeen(): number {
    return this.seen.size;
  }

  /**
   * The levels for every target. A target with no usable packet in the window is
   * `no_data` and will not be watched today — an illiquid stock that did not trade in
   * those 30 seconds has no opening range to break.
   */
  freeze(targets: Iterable<Target>): FrozenLevel[] {
    const levels: FrozenLevel[] = [];
    for (const { instrument, sources } of targets) {
      const base = {
        exchange: instrument.exchange,
        token: instrument.token,
        symbol: instrument.symbol,
        sources: [...sources].sort(),
      };
      const entry = this.seen.get(instrumentKey(instrument.exchange, instrument.token));
      const high = entry ? highest(positive(entry.last.dayHigh), entry.maxPrice) : null;
      const low = entry ? lowest(positive(entry.last.dayLow), entry.minPrice) : null;

      if (!entry || high === null || low === null) {
        levels.push({ ...base, status: 'no_data', high: null, low: null, open: null, packetAt: null });
        continue;
      }
      levels.push({
        ...base,
        status: 'ok',
        high,
        low,
        open: positive(entry.last.open),
        packetAt: entry.last.exchangeTime,
      });
    }
    return levels;
  }
}

export function breakoutKey(exchange: string, token: string, direction: BreakoutDirection): string {
  return `${exchange}:${token}:${direction}`;
}

/**
 * Reports the first break of each level: up when the day high goes above the range
 * high, down when the day low goes below the range low. Each fires once per instrument
 * per day; `alreadyFired` carries the ones a previous process recorded before a restart.
 */
export class BreakoutDetector {
  private readonly levels = new Map<string, FrozenLevel & { high: number; low: number }>();
  private readonly fired: Set<string>;

  constructor(
    levels: Iterable<FrozenLevel>,
    private readonly windowEnd: Date,
    alreadyFired: Iterable<string> = [],
  ) {
    for (const level of levels) {
      if (level.status === 'ok' && level.high !== null && level.low !== null) {
        this.levels.set(instrumentKey(level.exchange, level.token), { ...level, high: level.high, low: level.low });
      }
    }
    this.fired = new Set(alreadyFired);
  }

  get watching(): number {
    return this.levels.size;
  }

  check(packet: QuotePacket): BreakoutEvent[] {
    // Anything stamped inside the window is part of the range, not a break of it.
    if (packet.exchangeTime.getTime() < this.windowEnd.getTime()) return [];
    const level = this.levels.get(instrumentKey(packet.exchange, packet.token));
    if (!level) return [];

    const events: BreakoutEvent[] = [];
    const lastPrice = positive(packet.lastPrice);
    const high = highest(positive(packet.dayHigh), lastPrice);
    const low = lowest(positive(packet.dayLow), lastPrice);

    const fire = (direction: BreakoutDirection, price: number, levelPrice: number) => {
      const key = breakoutKey(level.exchange, level.token, direction);
      if (this.fired.has(key)) return;
      this.fired.add(key);
      events.push({
        exchange: level.exchange,
        token: level.token,
        symbol: level.symbol,
        direction,
        level: levelPrice,
        price,
        lastPrice: lastPrice ?? price,
        detectedAt: packet.exchangeTime,
      });
    };

    if (high !== null && high > level.high) fire('up', high, level.high);
    if (low !== null && low < level.low) fire('down', low, level.low);
    return events;
  }
}
