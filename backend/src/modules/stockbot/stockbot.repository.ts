import { execute, query, queryOne, type RowDataPacket, type SqlParam } from '../../db/pool';
import {
  FINAL_DAY_STATUSES,
  type BreakoutEvent,
  type DayStatus,
  type Exchange,
  type FrozenLevel,
  type LevelStatus,
} from './stockbot.schema';
import { breakoutKey } from './openingRange';

/**
 * SQL for the bot's three tables (migration 036). Dates go in as 'YYYY-MM-DD' strings
 * and come back through DATE_FORMAT, because mysql2 turns a bare DATE into midnight UTC.
 * DECIMAL columns come back as strings and are converted here.
 */

/* -------------------------------------------------------------------------- */
/* Days and the session lease                                                  */
/* -------------------------------------------------------------------------- */

export type DayRecord = {
  tradeDate: string;
  status: DayStatus;
  attempts: number;
  targetCount: number | null;
  levelsOk: number | null;
  levelsMissing: number | null;
  lastError: string | null;
  runnerLabel: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  frozenAt: Date | null;
  finishedAt: Date | null;
};

interface DayRow extends RowDataPacket {
  trade_date: string;
  status: DayStatus;
  attempts: number;
  target_count: number | null;
  levels_ok: number | null;
  levels_missing: number | null;
  last_error: string | null;
  runner_label: string | null;
  lease_expires_at: Date | null;
  started_at: Date | null;
  frozen_at: Date | null;
  finished_at: Date | null;
}

const DAY_COLUMNS = `DATE_FORMAT(trade_date, '%Y-%m-%d') AS trade_date, status, attempts, target_count,
  levels_ok, levels_missing, last_error, runner_label, lease_expires_at, started_at, frozen_at, finished_at`;

function toDay(row: DayRow): DayRecord {
  return {
    tradeDate: row.trade_date,
    status: row.status,
    attempts: row.attempts,
    targetCount: row.target_count,
    levelsOk: row.levels_ok,
    levelsMissing: row.levels_missing,
    lastError: row.last_error,
    runnerLabel: row.runner_label,
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.started_at,
    frozenAt: row.frozen_at,
    finishedAt: row.finished_at,
  };
}

export async function findDay(tradeDate: string): Promise<DayRecord | null> {
  const row = await queryOne<DayRow>(`SELECT ${DAY_COLUMNS} FROM stockbot_days WHERE trade_date = ?`, [tradeDate]);
  return row ? toDay(row) : null;
}

/** The day's row, created on first sight. */
export async function ensureDay(tradeDate: string): Promise<DayRecord> {
  await execute('INSERT IGNORE INTO stockbot_days (trade_date) VALUES (?)', [tradeDate]);
  const day = await findDay(tradeDate);
  if (!day) throw new Error(`stockbot_days row for ${tradeDate} vanished after insert`);
  return day;
}

const FINAL_LIST = FINAL_DAY_STATUSES.map(() => '?').join(', ');

/**
 * Takes the day for `token` when it is not final and nobody holds a live lease. Exactly
 * one caller can win, whatever number of processes ask at once.
 */
export async function claimDay(tradeDate: string, token: string, label: string, leaseSeconds: number): Promise<boolean> {
  const result = await execute(
    `UPDATE stockbot_days
        SET runner_token = ?, runner_label = ?,
            lease_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),
            attempts = attempts + 1,
            started_at = COALESCE(started_at, UTC_TIMESTAMP())
      WHERE trade_date = ?
        AND status NOT IN (${FINAL_LIST})
        AND (runner_token IS NULL OR lease_expires_at < UTC_TIMESTAMP())`,
    [token, label, leaseSeconds, tradeDate, ...FINAL_DAY_STATUSES],
  );
  return result.affectedRows === 1;
}

/** False when the lease was lost: another process has taken over and this one must stop. */
export async function renewLease(tradeDate: string, token: string, leaseSeconds: number): Promise<boolean> {
  const result = await execute(
    `UPDATE stockbot_days SET lease_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)
      WHERE trade_date = ? AND runner_token = ?`,
    [leaseSeconds, tradeDate, token],
  );
  return result.affectedRows === 1;
}

/** Lets a successor start at once instead of waiting out the lease. */
export async function releaseLease(tradeDate: string, token: string): Promise<void> {
  await execute(
    'UPDATE stockbot_days SET runner_token = NULL, lease_expires_at = NULL WHERE trade_date = ? AND runner_token = ?',
    [tradeDate, token],
  );
}

export type DayUpdate = {
  status?: DayStatus;
  targetCount?: number;
  levelsOk?: number;
  levelsMissing?: number;
  /** null clears it. */
  lastError?: string | null;
  frozen?: boolean;
  finished?: boolean;
};

/** Updates the day, guarded by the lease token so a process that lost it changes nothing. */
export async function updateDay(tradeDate: string, token: string, update: DayUpdate): Promise<boolean> {
  const assignments: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null) => {
    assignments.push(`${column} = ?`);
    params.push(value);
  };

  if (update.status !== undefined) set('status', update.status);
  if (update.targetCount !== undefined) set('target_count', update.targetCount);
  if (update.levelsOk !== undefined) set('levels_ok', update.levelsOk);
  if (update.levelsMissing !== undefined) set('levels_missing', update.levelsMissing);
  if (update.lastError !== undefined) set('last_error', update.lastError === null ? null : update.lastError.slice(0, 255));
  if (update.frozen) assignments.push('frozen_at = UTC_TIMESTAMP()');
  if (update.finished) assignments.push('finished_at = UTC_TIMESTAMP()');
  if (assignments.length === 0) return true;

  const result = await execute(
    `UPDATE stockbot_days SET ${assignments.join(', ')} WHERE trade_date = ? AND runner_token = ?`,
    [...params, tradeDate, token],
  );
  return result.affectedRows === 1;
}

/**
 * Claims the day's one email of a kind. True means "send it now"; false means it was
 * already claimed. Claimed before sending, so a crash part-way never sends it twice.
 */
export async function claimDayEmail(tradeDate: string, kind: 'levels' | 'notice'): Promise<boolean> {
  const column = kind === 'levels' ? 'levels_emailed_at' : 'notice_emailed_at';
  const result = await execute(
    `UPDATE stockbot_days SET ${column} = UTC_TIMESTAMP() WHERE trade_date = ? AND ${column} IS NULL`,
    [tradeDate],
  );
  return result.affectedRows === 1;
}

/* -------------------------------------------------------------------------- */
/* Levels                                                                      */
/* -------------------------------------------------------------------------- */

interface LevelRow extends RowDataPacket {
  exchange: Exchange;
  token: string;
  symbol: string;
  sources: string;
  status: LevelStatus;
  range_high: string | null;
  range_low: string | null;
  open_price: string | null;
  packet_at: Date | null;
}

const decimal = (value: string | null): number | null => (value === null ? null : Number(value));

const LEVEL_BATCH = 200;

/** Saves the frozen levels. Re-saving a day overwrites it, so a retried freeze is harmless. */
export async function saveLevels(tradeDate: string, levels: readonly FrozenLevel[]): Promise<void> {
  for (let start = 0; start < levels.length; start += LEVEL_BATCH) {
    const batch = levels.slice(start, start + LEVEL_BATCH);
    const params: (string | number | Date | null)[] = [];
    for (const level of batch) {
      params.push(
        tradeDate,
        level.exchange,
        level.token,
        level.symbol.slice(0, 64),
        level.sources.join(',').slice(0, 500),
        level.status,
        level.high,
        level.low,
        level.open,
        level.packetAt,
      );
    }
    await execute(
      `INSERT INTO stockbot_levels
         (trade_date, exchange, token, symbol, sources, status, range_high, range_low, open_price, packet_at)
       VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON DUPLICATE KEY UPDATE
         symbol = VALUES(symbol), sources = VALUES(sources), status = VALUES(status),
         range_high = VALUES(range_high), range_low = VALUES(range_low),
         open_price = VALUES(open_price), packet_at = VALUES(packet_at)`,
      params,
    );
  }
}

export async function loadLevels(tradeDate: string): Promise<FrozenLevel[]> {
  const rows = await query<LevelRow>(
    `SELECT exchange, token, symbol, sources, status, range_high, range_low, open_price, packet_at
       FROM stockbot_levels WHERE trade_date = ? ORDER BY symbol`,
    [tradeDate],
  );
  return rows.map((row) => ({
    exchange: row.exchange,
    token: row.token,
    symbol: row.symbol,
    sources: row.sources ? row.sources.split(',') : [],
    status: row.status,
    high: decimal(row.range_high),
    low: decimal(row.range_low),
    open: decimal(row.open_price),
    packetAt: row.packet_at,
  }));
}

/* -------------------------------------------------------------------------- */
/* Breakouts                                                                   */
/* -------------------------------------------------------------------------- */

export type BreakoutRecord = BreakoutEvent & { alertedAt: Date | null };

interface BreakoutRow extends RowDataPacket {
  exchange: Exchange;
  token: string;
  symbol: string;
  direction: 'up' | 'down';
  level_price: string;
  breakout_price: string;
  last_price: string;
  detected_at: Date;
  alerted_at: Date | null;
}

function toBreakout(row: BreakoutRow): BreakoutRecord {
  return {
    exchange: row.exchange,
    token: row.token,
    symbol: row.symbol,
    direction: row.direction,
    level: Number(row.level_price),
    price: Number(row.breakout_price),
    lastPrice: Number(row.last_price),
    detectedAt: row.detected_at,
    alertedAt: row.alerted_at,
  };
}

const BREAKOUT_COLUMNS =
  'exchange, token, symbol, direction, level_price, breakout_price, last_price, detected_at, alerted_at';

/** True when this is the first record of that break today. */
export async function insertBreakout(tradeDate: string, event: BreakoutEvent): Promise<boolean> {
  const result = await execute(
    `INSERT IGNORE INTO stockbot_breakouts
       (trade_date, exchange, token, symbol, direction, level_price, breakout_price, last_price, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tradeDate,
      event.exchange,
      event.token,
      event.symbol.slice(0, 64),
      event.direction,
      event.level,
      event.price,
      event.lastPrice,
      event.detectedAt,
    ],
  );
  return result.affectedRows === 1;
}

/** `breakoutKey`s already recorded today, so a restarted session does not fire them again. */
export async function firedBreakoutKeys(tradeDate: string): Promise<string[]> {
  const rows = await query<BreakoutRow>(
    `SELECT ${BREAKOUT_COLUMNS} FROM stockbot_breakouts WHERE trade_date = ?`,
    [tradeDate],
  );
  return rows.map((row) => breakoutKey(row.exchange, row.token, row.direction));
}

export async function listBreakouts(tradeDate: string): Promise<BreakoutRecord[]> {
  const rows = await query<BreakoutRow>(
    `SELECT ${BREAKOUT_COLUMNS} FROM stockbot_breakouts WHERE trade_date = ? ORDER BY detected_at, id`,
    [tradeDate],
  );
  return rows.map(toBreakout);
}

/** Takes every unclaimed break of the day for one alert email. */
export async function claimAlerts(tradeDate: string, claim: string): Promise<BreakoutRecord[]> {
  await execute(
    'UPDATE stockbot_breakouts SET alert_claim = ? WHERE trade_date = ? AND alert_claim IS NULL',
    [claim, tradeDate],
  );
  const rows = await query<BreakoutRow>(
    `SELECT ${BREAKOUT_COLUMNS} FROM stockbot_breakouts WHERE alert_claim = ? ORDER BY detected_at, id`,
    [claim],
  );
  return rows.map(toBreakout);
}

export async function settleAlerts(claim: string): Promise<void> {
  await execute('UPDATE stockbot_breakouts SET alerted_at = UTC_TIMESTAMP() WHERE alert_claim = ?', [claim]);
}

/** A failed send gives its rows back for the next flush. */
export async function releaseAlerts(claim: string): Promise<void> {
  await execute(
    'UPDATE stockbot_breakouts SET alert_claim = NULL WHERE alert_claim = ? AND alerted_at IS NULL',
    [claim],
  );
}

/* -------------------------------------------------------------------------- */
/* The status page — every list one bounded page at a time                     */
/* -------------------------------------------------------------------------- */

export const PAGE_SIZE_MAX = 100;
export const PAGE_MAX = 1_000;

export type PageSlice<T> = { items: T[]; total: number };

/**
 * LIMIT and OFFSET are the only values interpolated into SQL here, so they are checked
 * as bounded integers again even though the route's schema already did.
 */
function pageClause(limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX) throw new Error('bad page size');
  if (!Number.isInteger(offset) || offset < 0 || offset > PAGE_SIZE_MAX * PAGE_MAX) throw new Error('bad offset');
  return `LIMIT ${limit} OFFSET ${offset}`;
}

/** `AND symbol LIKE 'RELI%'` for an optional search, with LIKE's wildcards escaped. */
function symbolFilter(search: string | null, params: SqlParam[]): string {
  if (!search) return '';
  params.push(`${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
  return ' AND symbol LIKE ?';
}

interface CountRow extends RowDataPacket {
  total: number;
}

/** A day's levels, the ones with a range first, then by symbol. */
export async function levelsPage(
  tradeDate: string,
  search: string | null,
  limit: number,
  offset: number,
): Promise<PageSlice<FrozenLevel>> {
  const params: SqlParam[] = [tradeDate];
  const filter = symbolFilter(search, params);
  const count = await queryOne<CountRow>(
    `SELECT COUNT(*) AS total FROM stockbot_levels WHERE trade_date = ?${filter}`,
    params,
  );
  const rows = await query<LevelRow>(
    `SELECT exchange, token, symbol, sources, status, range_high, range_low, open_price, packet_at
       FROM stockbot_levels WHERE trade_date = ?${filter}
      ORDER BY status = 'no_data', symbol, id ${pageClause(limit, offset)}`,
    params,
  );
  return {
    total: Number(count?.total ?? 0),
    items: rows.map((row) => ({
      exchange: row.exchange,
      token: row.token,
      symbol: row.symbol,
      sources: row.sources ? row.sources.split(',') : [],
      status: row.status,
      high: decimal(row.range_high),
      low: decimal(row.range_low),
      open: decimal(row.open_price),
      packetAt: row.packet_at,
    })),
  };
}

/** A day's breaks, newest first. */
export async function breakoutsPage(
  tradeDate: string,
  search: string | null,
  limit: number,
  offset: number,
): Promise<PageSlice<BreakoutRecord>> {
  const params: SqlParam[] = [tradeDate];
  const filter = symbolFilter(search, params);
  const count = await queryOne<CountRow>(
    `SELECT COUNT(*) AS total FROM stockbot_breakouts WHERE trade_date = ?${filter}`,
    params,
  );
  const rows = await query<BreakoutRow>(
    `SELECT ${BREAKOUT_COLUMNS} FROM stockbot_breakouts WHERE trade_date = ?${filter}
      ORDER BY detected_at DESC, id DESC ${pageClause(limit, offset)}`,
    params,
  );
  return { total: Number(count?.total ?? 0), items: rows.map(toBreakout) };
}

interface DateRow extends RowDataPacket {
  trade_date: string | null;
}

/** The trading days the bot recorded either side of `tradeDate`, for day-to-day links. */
export async function adjacentDays(tradeDate: string): Promise<{ previous: string | null; next: string | null }> {
  const previous = await queryOne<DateRow>(
    "SELECT DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS trade_date FROM stockbot_days WHERE trade_date < ?",
    [tradeDate],
  );
  const next = await queryOne<DateRow>(
    "SELECT DATE_FORMAT(MIN(trade_date), '%Y-%m-%d') AS trade_date FROM stockbot_days WHERE trade_date > ?",
    [tradeDate],
  );
  return { previous: previous?.trade_date ?? null, next: next?.trade_date ?? null };
}

/**
 * Claims left by a process that died between claiming and sending. Called by the new
 * lease holder only, so it cannot steal a live flush. Those breaks may be mailed twice;
 * a duplicate alert is better than a lost one.
 */
export async function releaseAbandonedAlerts(tradeDate: string): Promise<void> {
  await execute(
    `UPDATE stockbot_breakouts SET alert_claim = NULL
      WHERE trade_date = ? AND alert_claim IS NOT NULL AND alerted_at IS NULL`,
    [tradeDate],
  );
}
