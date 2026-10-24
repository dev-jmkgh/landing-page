import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { companyDate } from '../telecalling/companyTime';
import { logger } from '../../utils/logger';
import type { Exchange, Instrument } from './stockbot.schema';

/**
 * Angel's instrument master: every tradable token, as one public JSON file (~150,000
 * rows, ~36 MB, all segments). Downloaded once per IST day into the cache directory and
 * reused for the rest of it; only the NSE and BSE cash segments are indexed.
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

type MasterRow = {
  token?: unknown;
  symbol?: unknown;
  name?: unknown;
  instrumenttype?: unknown;
  exch_seg?: unknown;
};

export class InstrumentIndex {
  private readonly bySymbol = new Map<string, Instrument>();
  private readonly byToken = new Map<string, Instrument>();
  private readonly indexByName = new Map<string, Instrument>();

  constructor(rows: Iterable<MasterRow>) {
    for (const row of rows) {
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
