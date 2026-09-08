import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { config } from '../config/env';
import { describeError, logger } from '../utils/logger';

/**
 * MySQL connection pool.
 *
 * Every query in the application goes through `query`/`execute` with bound parameters —
 * no SQL string is ever built by concatenating user input.
 *
 * Time is handled in UTC from end to end, and both halves of that are set here. See the
 * note on the session time zone below — the driver option and the session variable have
 * to agree, and a mismatch between them is silent and off by the server's UTC offset.
 */

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;

  pool = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    waitForConnections: true,
    connectionLimit: config.database.connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4_unicode_ci',
    /*
     * The driver reads and writes DATETIME values as UTC wall clock: a bound Date is
     * converted to UTC before being stored, and a DATETIME read back is interpreted as
     * UTC. Paired with `SET time_zone` below — see there for why both are needed.
     */
    timezone: 'Z',
    dateStrings: false,
    // Prevents multiple statements from being smuggled into one query string.
    multipleStatements: false,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });

  /**
   * Pins every pooled connection's session time zone to UTC.
   *
   * This is not cosmetic, and it was a live bug. `timezone: 'Z'` above makes the driver
   * store DATETIME values as UTC wall clock, but it has no effect on the SQL functions
   * evaluated inside MySQL. `NOW()` and `CURDATE()` used the server's system zone, so
   * every comparison of a stored column against the current time compared a UTC value
   * against a local one and was wrong by the server's UTC offset.
   *
   * On this deployment (IST, UTC+5:30) the visible symptom was that a follow-up became
   * "overdue" five and a half hours before it was due: a follow-up set for 18:30 IST is
   * stored as 13:00, and `13:00 < NOW()` was true from 13:00 IST onwards. The same
   * mismatch applied to the "due today" counts, the reminder sweep, and the mobile
   * session expiry checks in `mobileAuth.service.ts`.
   *
   * Fixed here rather than by rewriting each query to `UTC_TIMESTAMP()`/`UTC_DATE()`.
   * There are around forty such call sites; converting them individually leaves the next
   * query anyone writes with the same trap, and leaves the two clocks still nominally
   * different. Setting the session zone makes UTC the single meaning of "now" for both
   * the driver and the server.
   *
   * Applied per connection because the pool opens them lazily and a session variable is
   * scoped to its own connection, so it cannot be set once at startup.
   */
  pool.on('connection', (connection) => {
    /*
     * The callback form, and the cast, are both deliberate.
     *
     * `mysql2/promise` types this event's argument as a promise-flavoured
     * PoolConnection, but at runtime the promise pool forwards the underlying CALLBACK
     * connection. Awaiting it throws "the result of query that is not a promise" — so
     * the types are wrong here and the cast documents that rather than hiding it.
     *
     * The error is logged, not thrown: this runs on a pool event with no request to
     * attribute a failure to, and an unhandled error would take the process down. A
     * connection whose zone was not set still works — the cost is wrong time comparisons
     * on that one connection, which deserves a loud log rather than a crash.
     */
    const raw = connection as unknown as {
      query: (sql: string, callback: (error: unknown) => void) => void;
    };

    raw.query("SET time_zone = '+00:00'", (error: unknown) => {
      if (error) {
        logger.error('Failed to set session time zone to UTC on a pooled connection', {
          error: describeError(error),
        });
      }
    });
  });

  return pool;
}

/** Values accepted as bound query parameters. */
export type SqlParam = string | number | boolean | null | Date | Buffer;

/** SELECT helper. Always call with `?` placeholders and a params array. */
export async function query<T extends RowDataPacket>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const [rows] = await getPool().execute<T[]>(sql, params);
  return rows;
}

/** Single-row SELECT helper. */
export async function queryOne<T extends RowDataPacket>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** INSERT/UPDATE/DELETE helper. */
export async function execute(sql: string, params: SqlParam[] = []): Promise<ResultSetHeader> {
  const [result] = await getPool().execute<ResultSetHeader>(sql, params);
  return result;
}

/** Runs `handler` inside a transaction, rolling back on any error. */
export async function withTransaction<T>(
  handler: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** Startup check so bad credentials fail visibly rather than on the first enquiry. */
export async function verifyConnection(): Promise<boolean> {
  try {
    const connection = await getPool().getConnection();
    await connection.ping();
    connection.release();
    logger.info('Database connection established', {
      host: config.database.host,
      database: config.database.database,
    });
    return true;
  } catch (error) {
    logger.error('Database connection failed', describeError(error));
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export type { ResultSetHeader, RowDataPacket };
