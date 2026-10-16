import { execute, query, type RowDataPacket } from '../../../db/pool';

/**
 * Company-wide HR policy values (`hr_settings`, migration 027).
 *
 * Each key is typed and validated HERE, the one place that reads the table, so a
 * malformed value typed into the database by hand degrades to the default rather than
 * crashing payroll halfway through a run.
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type HrSettings = {
  /**
   * `YYYY-MM-DD`, or null. Payroll does not judge days before it present or absent —
   * the system did not exist then, so "no punch" carries no meaning. Null judges every
   * day in a period.
   */
  attendanceTrackedFrom: string | null;
  /** Weekly-off days for an employee with no shift. */
  defaultWeeklyOff: Weekday[];
  /**
   * The day of the month a pay period starts on, 1 to 28. 1 is the calendar month; 26
   * is "26th to 25th". The period is named after the month it ENDS in, so with 26 the
   * October period runs 26 September to 25 October. Capped at 28 so every month has
   * the day.
   */
  payrollCycleStartDay: number;
};

export const HR_SETTING_KEYS = {
  attendanceTrackedFrom: 'attendance_tracked_from',
  defaultWeeklyOff: 'default_weekly_off',
  payrollCycleStartDay: 'payroll_cycle_start_day',
} as const;

const DEFAULT_WEEKLY_OFF: Weekday[] = ['sun'];

function validCycleDay(value: string | number | null | undefined): number {
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 28 ? day : 1;
}

/** Parses a SET-style list (`'sat,sun'`) into weekdays, dropping anything unknown. */
export function parseWeekdays(value: string | null | undefined, fallback: Weekday[] = DEFAULT_WEEKLY_OFF): Weekday[] {
  if (value === null || value === undefined) return fallback;
  const parsed = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is Weekday => (WEEKDAYS as readonly string[]).includes(part));
  // An explicitly empty value is a real choice — no weekly off at all.
  return value.trim() === '' ? [] : parsed.length > 0 ? parsed : fallback;
}

function validDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

export async function getHrSettings(): Promise<HrSettings> {
  const rows = await query<RowDataPacket & { setting_key: string; setting_value: string | null }>(
    'SELECT setting_key, setting_value FROM hr_settings',
  );
  const map = new Map(rows.map((row) => [row.setting_key, row.setting_value]));

  return {
    attendanceTrackedFrom: validDate(map.get(HR_SETTING_KEYS.attendanceTrackedFrom)),
    defaultWeeklyOff: map.has(HR_SETTING_KEYS.defaultWeeklyOff)
      ? parseWeekdays(map.get(HR_SETTING_KEYS.defaultWeeklyOff))
      : DEFAULT_WEEKLY_OFF,
    payrollCycleStartDay: validCycleDay(map.get(HR_SETTING_KEYS.payrollCycleStartDay)),
  };
}

/**
 * Writes the settings named in `patch`; keys left out are untouched. The caller audits.
 */
export async function updateHrSettings(
  patch: Partial<HrSettings>,
  actorId: number | null,
): Promise<HrSettings> {
  const writes: Array<[string, string | null]> = [];

  if (patch.attendanceTrackedFrom !== undefined) {
    writes.push([HR_SETTING_KEYS.attendanceTrackedFrom, validDate(patch.attendanceTrackedFrom)]);
  }
  if (patch.defaultWeeklyOff !== undefined) {
    const days = WEEKDAYS.filter((day) => patch.defaultWeeklyOff!.includes(day));
    writes.push([HR_SETTING_KEYS.defaultWeeklyOff, days.join(',')]);
  }
  if (patch.payrollCycleStartDay !== undefined) {
    writes.push([HR_SETTING_KEYS.payrollCycleStartDay, String(validCycleDay(patch.payrollCycleStartDay))]);
  }

  for (const [key, value] of writes) {
    await execute(
      `INSERT INTO hr_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [key, value, actorId],
    );
  }

  return getHrSettings();
}
