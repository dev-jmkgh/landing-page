import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { config } from '../config/env';
import { describeError, logger } from '../utils/logger';

/**
 * MySQL connection pool.
 *
 * Every query in the application goes through `query`/`execute` with bound parameters —
 * no SQL string is ever built by concatenating user input.
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
    timezone: 'Z',
    dateStrings: false,
    // Prevents multiple statements from being smuggled into one query string.
    multipleStatements: false,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
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
