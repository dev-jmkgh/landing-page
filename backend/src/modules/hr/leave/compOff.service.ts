import { query, type RowDataPacket } from '../../../db/pool';
import { DAY_OVER } from '../attendance/dayJudge';
import { addDays, companyToday, countLeaveDays } from '../calendar/calendar.service';
import { getHrSettings } from '../settings/hrSettings';
import { claimedCompOffDays, type Db } from './leave.repository';
import type { CompOffDay } from './leave.schema';

/**
 * Compensatory leave (migration 038): which days an employee has EARNED one by.
 *
 * A day earns one day off when all of these hold:
 *
 *   - it was a weekly off or a (non-optional) holiday for them — the same classifier that
 *     makes those days free in a leave request, so the two can never disagree;
 *   - they checked in and out, on a shift, and worked at least that shift's FULL-DAY
 *     minimum (`half_day_minutes`) — the user's rule: full days only, no half credit;
 *   - the day is over (`DAY_OVER`), so the hours are final;
 *   - it is not already named by a pending or approved compensatory leave request;
 *   - the day off is still possible: it must be taken within `compOffValidityDays` (an HR
 *     setting, 30 by default) of the day worked.
 *
 * Nothing is stored: like every balance, it is derived whenever it is asked for, so a
 * corrected punch or a cancelled request is reflected at once.
 */

export type WorkedOffDay = {
  date: string;
  /** Why it was a day off; null when it was a working day (it earns nothing). */
  reason: 'weekly_off' | 'holiday' | null;
  holidayName: string | null;
  /** Null when there is no finished attendance that day. */
  workedMinutes: number | null;
  /** The shift's full-day minimum; null when the day was worked with no shift. */
  requiredMinutes: number | null;
  /** The day, and any overnight shift, has ended. */
  over: boolean;
};

export function earns(day: WorkedOffDay): boolean {
  return (
    day.reason !== null &&
    day.over &&
    day.workedMinutes !== null &&
    day.requiredMinutes !== null &&
    day.workedMinutes >= day.requiredMinutes
  );
}

/**
 * Every weekly off and holiday in [from, to], with what was worked on it. Days the
 * employee did not work are included (with null minutes), so a caller asked about one
 * date can say exactly why it does not count.
 */
export async function workedOffDays(userId: number, from: string, to: string): Promise<WorkedOffDay[]> {
  const [count, attendance] = await Promise.all([
    countLeaveDays(userId, from, to),
    query<
      RowDataPacket & {
        work_date: string;
        worked_minutes: number | null;
        half_day_minutes: number | null;
        finished: number;
        day_over: number;
      }
    >(
      // `day_over`, not `over`: OVER is a reserved word in MySQL 8.
      `SELECT DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date, a.worked_minutes, s.half_day_minutes,
              (a.checked_out_at IS NOT NULL AND a.worked_minutes IS NOT NULL) AS finished,
              (${DAY_OVER}) AS day_over
         FROM hr_attendance a
         LEFT JOIN hr_shifts s ON s.id = a.shift_id
        WHERE a.user_id = ? AND a.work_date BETWEEN ? AND ?`,
      [userId, from, to],
    ),
  ]);

  const byDate = new Map(attendance.map((row) => [row.work_date, row]));
  const days: WorkedOffDay[] = [];
  for (const entry of count.excluded) {
    if (entry.reason === 'not_employed') continue;
    const row = byDate.get(entry.date);
    const finished = row !== undefined && Number(row.finished) === 1;
    days.push({
      date: entry.date,
      reason: entry.reason,
      holidayName: entry.reason === 'holiday' ? (entry.name ?? null) : null,
      workedMinutes: finished ? Number(row.worked_minutes) : null,
      requiredMinutes: row && row.half_day_minutes !== null ? Number(row.half_day_minutes) : null,
      over: row !== undefined && Number(row.day_over) === 1,
    });
  }
  return days;
}

/** One date's standing, for a request that names it. */
export async function workedOffDay(userId: number, date: string): Promise<WorkedOffDay> {
  const [day] = await workedOffDays(userId, date, date);
  return day ?? { date, reason: null, holidayName: null, workedMinutes: null, requiredMinutes: null, over: true };
}

/** The last date a day off earned on `earnedOn` may be taken. */
export function compOffUseBy(earnedOn: string, validityDays: number): string {
  return addDays(earnedOn, validityDays);
}

/**
 * The days the employee may still name on a compensatory leave request, oldest first —
 * the order they lapse in.
 *
 * Pass `db` inside an application or approval: the claims must be read on the connection
 * that holds the employee's row lock, so two requests cannot both take the same day.
 */
export async function freeCompOffDays(userId: number, db?: Db): Promise<CompOffDay[]> {
  const { compOffValidityDays: validity } = await getHrSettings();
  const today = companyToday();
  // A day earned on `from` can be used until `from + validity` = today, the last that has
  // not lapsed. Today itself is never over yet.
  const from = addDays(today, -validity);
  const to = addDays(today, -1);

  const [days, claimed] = await Promise.all([
    workedOffDays(userId, from, to),
    claimedCompOffDays(db, userId, from, to),
  ]);

  return days
    .filter((day) => earns(day) && !claimed.has(day.date))
    .map((day) => ({
      date: day.date,
      reason: day.reason!,
      holidayName: day.holidayName,
      workedMinutes: day.workedMinutes!,
      requiredMinutes: day.requiredMinutes!,
      useBy: compOffUseBy(day.date, validity),
    }));
}
