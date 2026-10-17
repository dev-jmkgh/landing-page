import { execute } from '../../../db/pool';
import { describeError, logger } from '../../../utils/logger';
import { LOCAL_NOW, LOCAL_TODAY } from './attendance.schema';

/**
 * How a recorded day's status is decided — the one rule, shared by everything that sets it.
 *
 *   absent    the day is finished, THE DAY IS OVER, and it was worked for less than the
 *             shift's half-day minimum (`absent_minutes`)
 *   half_day  the day is finished, the day is over, and it was worked for less than the
 *             shift's full-day minimum (`half_day_minutes`)
 *   late      otherwise, when the first check-in was after start + grace
 *   present   otherwise
 *
 * WHY "THE DAY IS OVER". A check-out is not the end of the day. Judged at check-out,
 * somebody who left at 13:55 after 37 minutes read "Absent" while they could still come
 * back at 14:30 and work the afternoon; judged at the shift's end, somebody who started
 * late and stayed on past 18:00 to make up the hours would be marked short while still
 * at it. So the verdict on a day's hours waits until the day is over — midnight after the
 * work date, or the end of an overnight shift the next morning if that is later. Until
 * then a day is present (or late), however many times its owner checks out and back in.
 *
 * Because the verdict changes with the clock and not only with punches, something has to
 * look again once each day is over: the scheduler's nightly job (`hrScheduler`), payroll
 * before it calculates, and reads of attendance as a safety net (`ensureDaysJudged`).
 *
 * `a` is the attendance row and `s` its shift (no shift, no thresholds).
 */

/** The company clock has passed the end of the work date — or of its overnight shift, if later. */
const DAY_OVER = `${LOCAL_NOW} >= GREATEST(
        CAST(DATE_ADD(a.work_date, INTERVAL 1 DAY) AS DATETIME),
        CASE
          WHEN a.shift_ends_at IS NULL THEN CAST(DATE_ADD(a.work_date, INTERVAL 1 DAY) AS DATETIME)
          ELSE DATE_ADD(CAST(CONCAT(a.work_date, ' ', a.shift_ends_at) AS DATETIME),
                        INTERVAL (a.shift_starts_at IS NOT NULL AND a.shift_ends_at <= a.shift_starts_at) DAY)
        END)`;

const FINISHED = 'a.checked_out_at IS NOT NULL AND a.worked_minutes IS NOT NULL AND s.id IS NOT NULL';

export const DAY_STATUS_CASE = `CASE
      WHEN ${FINISHED} AND ${DAY_OVER} AND a.worked_minutes < s.absent_minutes THEN 'absent'
      WHEN ${FINISHED} AND ${DAY_OVER} AND a.worked_minutes < s.half_day_minutes THEN 'half_day'
      WHEN a.late_minutes > 0 THEN 'late'
      ELSE 'present'
    END`;

/** The statuses the rule owns. `on_leave` rows are written by other paths and kept. */
export const JUDGED_STATUSES = `('present', 'late', 'half_day', 'absent')`;

/**
 * Days inside an APPROVED pay period are never re-judged: their payslips are published and
 * frozen, and attendance must go on agreeing with what was paid.
 */
const AFTER_APPROVED_PAY = `a.work_date > COALESCE(
        (SELECT MAX(r.period_end) FROM hr_payroll_runs r WHERE r.status = 'approved'),
        '1000-01-01')`;

/**
 * Re-judges the finished days worked on a shift after its thresholds change, and returns
 * how many changed. Without it a new rule would only reach a day when somebody next
 * punched or corrected it — the setting would look as if it did nothing.
 */
export async function rejudgeShiftDays(shiftId: number): Promise<number> {
  const result = await execute(
    `UPDATE hr_attendance a
       JOIN hr_shifts s ON s.id = a.shift_id
        SET a.status = ${DAY_STATUS_CASE}
      WHERE a.shift_id = ?
        AND a.checked_out_at IS NOT NULL
        AND a.status IN ${JUDGED_STATUSES}
        AND ${AFTER_APPROVED_PAY}`,
    [shiftId],
  );
  return Number(result.changedRows ?? 0);
}

/**
 * Gives every finished day the verdict the rule gives it NOW, and returns how many changed
 * — in practice the days that ended since the last pass (present → half day or absent),
 * and any judged early by older code (back to present until the day is over).
 *
 * Bounded to the last 45 days after the last approved pay period: older days have long
 * since been judged by an earlier pass, and the bound keeps the per-minute run cheap.
 * Only rows whose status would actually change are written.
 */
export async function judgeEndedDays(): Promise<number> {
  const result = await execute(
    `UPDATE hr_attendance a
       JOIN hr_shifts s ON s.id = a.shift_id
        SET a.status = ${DAY_STATUS_CASE}
      WHERE a.checked_out_at IS NOT NULL
        AND a.status IN ${JUDGED_STATUSES}
        AND a.work_date >= DATE_SUB(${LOCAL_TODAY}, INTERVAL 45 DAY)
        AND ${AFTER_APPROVED_PAY}
        AND a.status <> ${DAY_STATUS_CASE}`,
  );
  return Number(result.changedRows ?? 0);
}

/*
 * Reads call this rather than `judgeEndedDays` directly: at most one pass a minute per
 * process, and never a failed read because of it. The scheduler's nightly job is the main
 * pass; this is the safety net for a night the server was down, and what moves days on
 * locally, where the scheduler is off.
 */
const THROTTLE_MS = 60_000;
let lastPassAt = 0;
let pass: Promise<void> | null = null;

export function ensureDaysJudged(): Promise<void> {
  if (pass) return pass;
  if (Date.now() - lastPassAt < THROTTLE_MS) return Promise.resolve();
  lastPassAt = Date.now();
  pass = judgeEndedDays()
    .then((changed) => {
      if (changed > 0) logger.info('HR days judged after they ended', { changed });
    })
    .catch((error) => {
      logger.warn('Could not judge ended HR days; the next read will try again', describeError(error));
      lastPassAt = 0;
    })
    .finally(() => {
      pass = null;
    });
  return pass;
}
