import fs from 'node:fs/promises';
import { logger } from '../../utils/logger';
import type { InstrumentIndex } from './instruments';
import type { Holding } from './smartapi.client';
import {
  CASH_EXCHANGES,
  EXCHANGES,
  FNO_SOURCE,
  HOLDINGS_SOURCE,
  WATCHLIST_SOURCE_PREFIX,
  instrumentKey,
  watchlistFileSchema,
  type CashExchange,
  type Exchange,
  type Instrument,
  type Target,
} from './stockbot.schema';

/**
 * The day's target list: the client's holdings, every NSE F&O stock, and any extra
 * stocks in watchlists.json — one entry per instrument however many lists name it.
 *
 * The F&O list replaces the client's own watchlists, which Angel offers no way to read:
 * SmartAPI has no watchlist endpoint and the app has no export.
 *
 * Holdings move to the preferred exchange when the company is listed there, so a stock
 * held through BSE and watched on NSE is tracked once, on NSE — two listings would give
 * two different opening ranges for one company. A watchlist entry that names its exchange
 * (`BSE:SBIN`) is taken at its word.
 */

export type TargetList = {
  targets: Map<string, Target>;
  /** Entries that could not be matched to an instrument, for the log and the email. */
  unresolved: string[];
};

/**
 * `NSE:RELIANCE` -> NSE/RELIANCE; `RELIANCE` -> the preferred exchange. A contract needs
 * its segment and exact trading symbol: `BFO:SENSEX26OCT73800CE`, `NFO:NIFTY27OCT2622700CE`.
 */
export function parseWatchlistEntry(entry: string, preferred: CashExchange): { exchange: Exchange; symbol: string } {
  const separator = entry.indexOf(':');
  if (separator === -1) return { exchange: preferred, symbol: entry.trim() };

  const prefix = entry.slice(0, separator).trim().toUpperCase();
  const exchange = EXCHANGES.find((candidate) => candidate === prefix);
  if (!exchange) throw new Error(`unsupported exchange ${JSON.stringify(prefix)}`);
  return { exchange, symbol: entry.slice(separator + 1).trim() };
}

/** Reads watchlists.json. A missing file means holdings only; a malformed one is an error. */
export async function readWatchlists(file: string): Promise<Record<string, string[]>> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn('Stock bot: no watchlists.json; tracking holdings only', { file });
      return {};
    }
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const parsed = watchlistFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} must look like {"watchlists": {"Name": ["RELIANCE", "BSE:SBIN"]}}`);
  }
  return parsed.data.watchlists;
}

export function buildTargetList(
  holdings: readonly Holding[],
  watchlists: Record<string, readonly string[]>,
  index: InstrumentIndex,
  preferred: CashExchange,
): TargetList {
  const targets = new Map<string, Target>();
  const unresolved: string[] = [];

  const add = (instrument: Instrument, source: string) => {
    const key = instrumentKey(instrument.exchange, instrument.token);
    const existing = targets.get(key);
    if (existing) existing.sources.add(source);
    else targets.set(key, { instrument, sources: new Set([source]) });
  };

  for (const holding of holdings) {
    const exchange = CASH_EXCHANGES.find((candidate) => candidate === holding.exchange);
    const token = holding.symboltoken === undefined ? '' : String(holding.symboltoken);
    const symbol = holding.tradingsymbol ?? '?';
    if (!exchange || !token) {
      unresolved.push(`holding ${symbol} (${holding.exchange ?? 'no exchange'})`);
      continue;
    }

    // A holding missing from today's master (a fresh listing) is still subscribable by
    // its own token.
    const instrument = index.findByToken(exchange, token) ?? {
      exchange,
      token,
      symbol,
      name: symbol,
      isIndex: false,
    };
    add(index.listingOn(instrument, preferred) ?? instrument, HOLDINGS_SOURCE);
  }

  // F&O is an NSE list, so these stay on NSE whatever the preferred exchange.
  const fno = index.fnoStocks();
  for (const instrument of fno.instruments) add(instrument, FNO_SOURCE);
  for (const name of fno.unresolved) unresolved.push(`F&O: ${name} (no NSE cash listing)`);

  for (const [name, entries] of Object.entries(watchlists)) {
    for (const entry of entries) {
      let parsed: { exchange: Exchange; symbol: string };
      try {
        parsed = parseWatchlistEntry(entry, preferred);
      } catch (error) {
        unresolved.push(`${name}: ${entry} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      const instrument = index.resolve(parsed.exchange, parsed.symbol);
      if (!instrument) {
        unresolved.push(`${name}: ${entry}`);
        continue;
      }
      add(instrument, WATCHLIST_SOURCE_PREFIX + name);
    }
  }

  return { targets, unresolved };
}
