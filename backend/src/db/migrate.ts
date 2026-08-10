import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env';
import { closePool, execute, getPool, query, type RowDataPacket } from './pool';
import { describeError, logger } from '../utils/logger';

/**
 * Minimal forward-only migration runner.
 *
 * Applies every `.sql` file in `backend/database/migrations` in filename order, once,
 * and records a checksum so an already-applied file that later changes is reported
 * rather than silently ignored.
 *
 * Usage:  npm run db:migrate      (development, via tsx)
 *         npm run db:migrate:prod (after `npm run build`)
 */

/**
 * Locations checked for migration files, in order.
 *
 * The SQL lives inside `backend/`, so deploying the backend folder brings its schema
 * with it — there is no second directory to remember to upload. The first two entries
 * cover `src/db` (tsx) and `dist/db` (compiled); the rest are fallbacks for unusual
 * working directories.
 */
const MIGRATION_DIR_CANDIDATES = [
  process.env.MIGRATIONS_DIR,
  path.resolve(__dirname, '../../database/migrations'),
  path.resolve(process.cwd(), 'database/migrations'),
  path.resolve(process.cwd(), 'backend/database/migrations'),
].filter((candidate): candidate is string => Boolean(candidate));

async function resolveMigrationsDir(): Promise<string> {
  for (const candidate of MIGRATION_DIR_CANDIDATES) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `Could not find the migrations directory. Looked in:\n${MIGRATION_DIR_CANDIDATES.map(
      (candidate) => `  - ${candidate}`,
    ).join('\n')}\nSet MIGRATIONS_DIR to an absolute path to override.`,
  );
}

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    filename   VARCHAR(190) NOT NULL,
    checksum   CHAR(64)     NOT NULL,
    applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_schema_migrations_filename (filename)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;

interface MigrationRow extends RowDataPacket {
  filename: string;
  checksum: string;
}

/** Splits a migration file into individual statements, ignoring `--` comments. */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export async function runMigrations(): Promise<void> {
  const migrationsDir = await resolveMigrationsDir();

  logger.info('Running database migrations', {
    database: config.database.database,
    directory: migrationsDir,
  });

  await execute(CREATE_MIGRATIONS_TABLE);

  const applied = await query<MigrationRow>('SELECT filename, checksum FROM schema_migrations');
  const appliedByName = new Map(applied.map((row) => [row.filename, row.checksum]));

  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

  if (files.length === 0) {
    logger.warn('No migration files found', { directory: migrationsDir });
    return;
  }

  let appliedCount = 0;

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const previous = appliedByName.get(file);

    if (previous) {
      if (previous !== checksum) {
        logger.warn(
          `Migration ${file} has changed since it was applied. ` +
            'Create a new migration file instead of editing an applied one.',
        );
      }
      continue;
    }

    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      for (const statement of splitStatements(sql)) {
        await connection.query(statement);
      }
      await connection.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
        [file, checksum],
      );
      await connection.commit();
      appliedCount += 1;
      logger.info(`Applied migration ${file}`);
    } catch (error) {
      await connection.rollback();
      logger.error(`Migration ${file} failed`, describeError(error));
      throw error;
    } finally {
      connection.release();
    }
  }

  logger.info(
    appliedCount === 0
      ? 'Database already up to date'
      : `Applied ${appliedCount} migration${appliedCount === 1 ? '' : 's'}`,
  );
}

/** Executed directly (`npm run db:migrate`) rather than imported. */
if (require.main === module) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (error) => {
      logger.error('Migration run failed', describeError(error));
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
