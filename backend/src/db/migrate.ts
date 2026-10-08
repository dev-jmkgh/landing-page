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
 * It runs as the application's own database user — production uses one database and
 * one user for everything — and that user has no DROP privilege (and may have no INDEX
 * privilege). Migrations therefore never DROP, TRUNCATE or RENAME a table, and add
 * indexes with ALTER TABLE ... ADD INDEX rather than CREATE INDEX. The e2e foundation
 * section fails the build when a file breaks that rule.
 *
 * Usage:  npm run db:migrate      (development, via tsx)
 *         npm run db:migrate:prod (after `npm run build`)
 */

/**
 * Earlier revisions of migrations that were rewritten after some databases had already
 * applied them, without changing what those databases ended up with.
 *
 * 019 first ended with a DROP TABLE, which the production user may not run (it failed
 * there), and several files used CREATE INDEX. They now need neither privilege: the
 * superseded table is left in place, and each CREATE INDEX became the equivalent
 * ALTER TABLE ... ADD INDEX. A database that ran an earlier revision already has the same
 * tables and indexes, so its stored checksum is accepted instead of being reported as an
 * edited migration. Each entry lists the earlier revision with LF and with CRLF line
 * endings, because a Windows checkout and git's copy of the same file hash differently.
 */
const EARLIER_REVISIONS: Readonly<Record<string, readonly string[]>> = {
  '014_calls_recorded_at.sql': [
    '1f0d3636b0c03c8de04631caa32c80bf0b3d9683a4c447e704a580e9a1e76a4a',
    'ecc4c4d5dd327776e29b76031df53049b65dedd3a1fe6175afb778ed17c72abd',
  ],
  '015_leads_unique_phone.sql': [
    'efcae31dce5aa4becc16215175b703666ec6eb4b0b9343b54924e6f63ebc853b',
    'c668b6f3d25ad8c456871c3736ca6628e95127ac5d4ab439e0ee6d95670e0ebe',
  ],
  '019_hr_attendance_sessions.sql': [
    '85da5e0f4887eb9827650b3788b4d53e726195112935b1ec2d2bc1b6b52e2dae',
    '800d5be163b3ea4515bc53d4189bb87d15e31ae17f291d0b81d96b8ed5537c42',
  ],
  '020_call_notes_and_follow_up_links.sql': [
    '6d4caee3d407f463a98258a3918a99881963b0404357f02c1207580536e69dc4',
    'bd8f5286cdd2bc694edf13066345f77c7b9fe9a9211f85daec62751f5c670993',
  ],
  '021_company_sim_line.sql': [
    'bef692e2381792b95c42145faa8170bd890d1a547430bf977d5d694613c0bd18',
    'bf589f99df135079ac86d813dc867edf28ed602808caad1810a2e732e6f7c203',
  ],
  '024_reporting_indexes.sql': [
    '6c05f411863451c6373a20b2e8d50b3e3050782e2ea8d9f962a5ee783138e4b5',
    '825687c8597c1d397f1b907d54792c1da37e9ddfcfd0cb71ca985d506a6e95f7',
  ],
};

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Checksums an applied file may legitimately carry: this content as read, the same
 * content with LF or with CRLF line endings, and any listed earlier revision.
 */
function acceptedChecksums(file: string, sql: string): Set<string> {
  const lf = sql.replace(/\r\n/g, '\n');
  return new Set([
    sha256(sql),
    sha256(lf),
    sha256(lf.replace(/\n/g, '\r\n')),
    ...(EARLIER_REVISIONS[file] ?? []),
  ]);
}

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
    const checksum = sha256(sql);
    const previous = appliedByName.get(file);

    if (previous) {
      if (!acceptedChecksums(file, sql).has(previous)) {
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
