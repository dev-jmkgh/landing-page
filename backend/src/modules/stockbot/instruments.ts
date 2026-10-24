import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { companyDate } from '../telecalling/companyTime';
import { logger } from '../../utils/logger';
import type { Exchange, Instrument } from './stockbot.schema';

/**
 * Angel's instrument master: every tradable token, as one public JSON file (~150,000
 * rows, ~36 MB, all segments). Downloaded once per IST day into the cache directory and
 * reused for the rest of it. The NSE and BSE cash segments are indexed, and the NFO stock
 * futures are read only for the list of F&O stocks.
 *
 * Trading symbols differ by exchange — `RELIANCE-EQ` on NSE (the series is part of the
 * symbol), `RELIANCE` on BSE — and indices use display names (`Nifty 50`, name `NIFTY`).
 * `resolve` accepts any of those, so a watchlist can say `RELIANCE` or `NIFTY`.
 */

const SCRIP_MASTER_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_ATTEMPTS = 3;
const CACHE_PREFIX = 'scrip_master_';

/** Series tried, in order, for a bare NSE symbol such as `RELIANCE`. */
const NSE_EQUITY_SERIES = ['EQ', 'BE', 'BZ', 'SM', 'ST'] as const;
const INDEX_TYPE = 'AMXIDX';

/**
 * F&O stocks are the underlyings of NSE stock futures (`FUTSTK` rows in the NFO segment).
 * Only futures expiring within this horizon count: real contracts run three months ahead,
 * while the exchange's test instruments (`011NSETEST` and friends) carry expiries a decade
 * out — they have NSE cash listings too, and must never be tracked.
 */
const FNO_EXPIRY_HORIZON_DAYS = 120;
const TEST_UNDERLYING = /NSETEST/i;

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** `27OCT2026` -> epoch ms at midnight UTC, or NaN. */
function parseExpiry(value: unknown): number {
  const match = typeof value === 'string' ? /^(\d{2})([A-Z]{3})(\d{4})$/.exec(value) : null;
  const month = match ? MONTHS[match[2] ?? ''] : undefined;
  return match && month !== undefined ? Date.UTC(Number(match[3]), month, Number(match[1])) : NaN;
}

type MasterRow = {
  token?: unknown;
  symbol?: unknown;
  name?: unknown;
  instrumenttype?: unknown;
  exch_seg?: unknown;
  expiry?: unknown;
};

export class InstrumentIndex {
  private readonly bySymbol = new Map<string, Instrument>();
  private readonly byToken = new Map<string, Instrument>();
  private readonly indexByName = new Map<string, Instrument>();
  private readonly fnoUnderlyings = new Set<string>();

  /** `asOf` decides which futures are current; the master lists only live contracts plus tests. */
  constructor(rows: Iterable<MasterRow>, asOf: Date = new Date()) {
    const earliestExpiry = asOf.getTime() - 86_400_000;
    const latestExpiry = asOf.getTime() + FNO_EXPIRY_HORIZON_DAYS * 86_400_000;

    for (const row of rows) {
      if (row.exch_seg === 'NFO' && row.instrumenttype === 'FUTSTK' && typeof row.name === 'string') {
        const expiry = parseExpiry(row.expiry);
        if (expiry >= earliestExpiry && expiry <= latestExpiry && !TEST_UNDERLYING.test(row.name)) {
          this.fnoUnderlyings.add(row.name);
        }
        continue;
      }

      const exchange = row.exch_seg;
      if ((exchange !== 'NSE' && exchange !== 'BSE') || typeof row.symbol !== 'string') continue;
      if (typeof row.token !== 'string' && typeof row.token !== 'number') continue;

      const instrument: Instrument = {
        exchange,
        token: String(row.token),
        symbol: row.symbol,
        name: typeof row.name === 'string' && row.name ? row.name : row.symbol,
        isIndex: row.instrumenttype === INDEX_TYPE,
      };
      this.bySymbol.set(`${exchange}:${instrument.symbol.toUpperCase()}`, instrument);
      this.byToken.set(`${exchange}:${instrument.token}`, instrument);
      if (instrument.isIndex) this.indexByName.set(`${exchange}:${instrument.name.toUpperCase()}`, instrument);
    }
  }

  get size(): number {
    return this.byToken.size;
  }

  findByToken(exchange: Exchange, token: string): Instrument | null {
    return this.byToken.get(`${exchange}:${token}`) ?? null;
  }

  /** A cash instrument by trading symbol, bare NSE symbol, or index name. */
  resolve(exchange: Exchange, symbol: string): Instrument | null {
    const wanted = symbol.trim().toUpperCase();
    const exact = this.bySymbol.get(`${exchange}:${wanted}`);
    if (exact) return exact;
    if (exchange === 'NSE') {
      for (const series of NSE_EQUITY_SERIES) {
        const found = this.bySymbol.get(`${exchange}:${wanted}-${series}`);
        if (found) return found;
      }
    }
    return this.indexByName.get(`${exchange}:${wanted}`) ?? null;
  }

  /** The same company's listing on another exchange, matched by name. */
  listingOn(instrument: Instrument, exchange: Exchange): Instrument | null {
    if (instrument.exchange === exchange) return instrument;
    if (instrument.isIndex) return null;
    return this.resolve(exchange, instrument.name);
  }

  /**
   * Every stock with a current NSE future, as its NSE cash instrument (~210 names). The
   * F&O list is the exchange's own liquidity filter, rebuilt from each morning's master,
   * so additions and removals need nobody to do anything.
   */
  fnoStocks(): { instruments: Instrument[]; unresolved: string[] } {
    const instruments: Instrument[] = [];
    const unresolved: string[] = [];
    for (const name of [...this.fnoUnderlyings].sort()) {
      const instrument = this.resolve('NSE', name);
      if (instrument && !instrument.isIndex) instruments.push(instrument);
      else unresolved.push(name);
    }
    return { instruments, unresolved };
  }
}

function parseRows(text: string): MasterRow[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== 'object') {
    throw new Error('the instrument master has an unexpected shape');
  }
  return rows as MasterRow[];
}

async function download(signal?: AbortSignal): Promise<string> {
  let lastFailure = 'no attempt made';
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(SCRIP_MASTER_URL, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
          : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (signal?.aborted) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
      if (attempt < DOWNLOAD_ATTEMPTS) {
        logger.warn('Stock bot: instrument master download failed; retrying', { reason: lastFailure });
        await sleep(5_000 * attempt, undefined, { signal });
      }
    }
  }
  throw new Error(`instrument master download failed: ${lastFailure}`);
}

/**
 * Today's index. Downloads when today's copy is not cached yet; falls back to the newest
 * cached copy when Angel's file server is unreachable, since cash-market tokens almost
 * never change from one day to the next.
 */
export async function loadInstruments(cacheDirectory: string, signal?: AbortSignal): Promise<InstrumentIndex> {
  await fs.mkdir(cacheDirectory, { recursive: true });
  const todayFile = path.join(cacheDirectory, `${CACHE_PREFIX}${companyDate()}.json`);

  try {
    const index = new InstrumentIndex(parseRows(await fs.readFile(todayFile, 'utf8')));
    logger.info('Stock bot: instrument master loaded from cache', { instruments: index.size });
    return index;
  } catch {
    // Not cached yet today (or unreadable): download below.
  }

  let text: string;
  let rows: MasterRow[];
  try {
    text = await download(signal);
    rows = parseRows(text);
  } catch (error) {
    if (signal?.aborted) throw error;
    const cached = (await fs.readdir(cacheDirectory))
      .filter((name) => name.startsWith(CACHE_PREFIX) && name.endsWith('.json'))
      .sort();
    const newest = cached[cached.length - 1];
    if (!newest) throw error;
    logger.warn('Stock bot: using an older cached instrument master', {
      file: newest,
      reason: error instanceof Error ? error.message : String(error),
    });
    return new InstrumentIndex(parseRows(await fs.readFile(path.join(cacheDirectory, newest), 'utf8')));
  }

  // Written atomically, and only after it parsed, so a half-download is never "today's copy".
  const temporary = `${todayFile}.tmp`;
  await fs.writeFile(temporary, text, 'utf8');
  await fs.rename(temporary, todayFile);
  for (const name of await fs.readdir(cacheDirectory)) {
    if (name.startsWith(CACHE_PREFIX) && path.join(cacheDirectory, name) !== todayFile) {
      await fs.rm(path.join(cacheDirectory, name), { force: true });
    }
  }

  const index = new InstrumentIndex(rows);
  logger.info('Stock bot: instrument master downloaded', { instruments: index.size });
  return index;
}
