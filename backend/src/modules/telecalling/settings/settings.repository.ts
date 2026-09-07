import { execute, query, queryOne, type RowDataPacket } from '../../../db/pool';
import { describeError, logger } from '../../../utils/logger';

/**
 * System settings (spec: Admin Module 15).
 *
 * A key/value table rather than one column per setting: these are operational switches
 * an admin flips, and each one should not cost a migration and a deploy.
 *
 * Values are JSON so a setting can be a boolean, a number, or a shape like working
 * hours without three parallel columns. The trade is that a caller has to know what type
 * it expects — hence the typed readers below rather than a bare `get`.
 */

/** Defaults, used when the row is missing or holds something unparseable. */
const DEFAULTS: Record<string, unknown> = {
  'recording.enabled': false,
  'recording.announce': true,
  'followup.reminder_minutes': 30,
  'followup.overdue_alert_hours': 24,
  'assignment.strategy': 'manual',
  'calling.working_hours': { start: '09:30', end: '18:30', timezone: 'Asia/Kolkata' },
};

export type SettingRecord = {
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: string;
};

/**
 * MySQL hands back a parsed JSON column; MariaDB hands back the raw string, because
 * there JSON is an alias for LONGTEXT. Both are handled so the API response does not
 * depend on which engine the deployment happens to run.
 */
function parseValue(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A string that is not valid JSON predates this column being JSON, or was written
    // by hand. Return it verbatim rather than throwing on a settings read.
    return raw;
  }
}

export async function listSettings(): Promise<SettingRecord[]> {
  const rows = await query<
    RowDataPacket & {
      setting_key: string;
      setting_value: unknown;
      description: string | null;
      updated_at: Date;
    }
  >(
    `SELECT setting_key, setting_value, description, updated_at
       FROM system_settings
      ORDER BY setting_key ASC`,
  );

  return rows.map((row) => ({
    key: row.setting_key,
    value: parseValue(row.setting_value),
    description: row.description,
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

/**
 * Reads one setting.
 *
 * Falls back to the compiled-in default rather than throwing. A missing settings row —
 * a fresh database, a migration not yet run — must not take down call logging; every
 * caller of this has a sensible default and none of them can do anything useful with an
 * exception.
 */
export async function readSetting<T>(key: string, fallback?: T): Promise<T> {
  const provided = fallback ?? (DEFAULTS[key] as T | undefined);

  try {
    const row = await queryOne<RowDataPacket & { setting_value: unknown }>(
      'SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1',
      [key],
    );

    if (!row) return provided as T;

    const parsed = parseValue(row.setting_value);
    return (parsed === null ? provided : parsed) as T;
  } catch (error) {
    logger.warn('Settings read failed; using default', { key, ...describeError(error) });
    return provided as T;
  }
}

export async function readBooleanSetting(key: string): Promise<boolean> {
  const value = await readSetting<unknown>(key);
  // A JSON column can legitimately hold `true`, `"true"` or `1` depending on how the
  // row was written. Treat all three as true rather than silently disabling a feature
  // an admin believes they turned on.
  return value === true || value === 'true' || value === 1;
}

export async function readNumberSetting(key: string, fallback: number): Promise<number> {
  const value = await readSetting<unknown>(key, fallback);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function writeSetting(
  key: string,
  value: unknown,
  updatedBy: number,
): Promise<void> {
  await execute(
    `INSERT INTO system_settings (setting_key, setting_value, updated_by)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    [key, JSON.stringify(value), updatedBy],
  );
}

/** The keys an admin may write. A closed list, so a typo creates an error, not a row. */
export const WRITABLE_SETTING_KEYS = [
  'recording.enabled',
  'recording.announce',
  'followup.reminder_minutes',
  'followup.overdue_alert_hours',
  'assignment.strategy',
  'calling.working_hours',
] as const;

export type WritableSettingKey = (typeof WRITABLE_SETTING_KEYS)[number];
