import { execute, query, type RowDataPacket } from '../../../db/pool';
import { describeError, logger } from '../../../utils/logger';
import { closeStaleSessions } from '../attendance/attendance.service';
import { judgeEndedDays } from '../attendance/dayJudge';
import { addDays, calendarForUsers, companyToday } from '../calendar/calendar.service';
import { notifyHr } from '../notifications/hrNotifications.repository';
import { companyInstant, shiftEndInstant } from '../reports/companyClock';

/**
 * The HR module's clock: reminders and the missing-punch sweep.
 *
 * Started from `server.ts` only (never from createApp), so the e2e harness gets no
 * timers. Every job is idempotent — reminders carry a dedupe key, the sweep only closes
 * sessions that are still open — so several processes running it at once are harmless.
 *
 * Same shape as the telecalling daily-report scheduler, for the same reasons: in
 * process rather than cron (nothing extra to install and forget on the next host), a
 * five-minute tick that asks the database what is due (so a restart or a second server
 * changes nothing), both timers unref'd (the schedule is never why the process stays
 * up), one tick at a time, and a tick that never throws — `server.ts` exits on an
 * uncaught exception, and a reminder is not worth the API.
 *
 * WHAT A TICK DOES
 *
 *   1. Closes sessions nobody checked out of (`closeStaleSessions`): the day becomes a
 *      missing punch and the employee is told.
 *   2. Check-in reminders — a working day whose shift start + grace passed within the
 *      last two hours, and nothing recorded yet.
 *   3. Check-out reminders — a session still open more than 30 minutes after the day's
 *      shift end.
 *
 * Shift times are company wall clock; they are turned into instants by the fixed
 * offset in `companyClock.ts`, never by the server process's own zone.
 */

export const HR_TICK_MS = 5 * 60_000;
export const HR_FIRST_DELAY_MS = 30_000;

/**
 * How long after a shift's start (+ grace) a check-in reminder is still worth sending.
 * Wider than one tick so a server restarting across the moment still catches it; not so
 * wide that somebody gets "time to check in" at lunchtime.
 */
const CHECK_IN_WINDOW_MS = 2 * 60 * 60_000;

/** A session still open this long after the shift end gets a check-out reminder. */
const CHECK_OUT_AFTER_MS = 30 * 60_000;

/** The sweep closes at most 500 per call; a few calls clear any realistic backlog. */
const MAX_SWEEP_ROUNDS = 5;

const CALENDAR_BATCH = 200;

/** While ticks keep failing, say so at most this often. */
const FAILURE_LOG_INTERVAL_MS = 30 * 60_000;

export type HrTickResult = {
  at: string;
  closedSessions: number;
  /** Rows actually written — a deduplicated repeat counts 0. */
  checkInReminders: number;
  checkOutReminders: number;
  /** Days given their verdict by the nightly pass; 0 on every tick but the night's first. */
  judgedDays: number;
  /** One entry per job that failed. The other jobs still ran. */
  failures: string[];
};

/* -------------------------------------------------------------------------- */
/* The jobs                                                                    */
/* -------------------------------------------------------------------------- */

async function sweepStaleSessions(): Promise<number> {
  let closed = 0;
  for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
    const count = await closeStaleSessions(null);
    closed += count;
    if (count < 500) break;
  }
  return closed;
}

interface ShiftCandidateRow extends RowDataPacket {
  id: number;
  starts_at: string;
  grace_minutes: number;
}

/**
 * Check-in reminders.
 *
 * Both today AND yesterday are considered, because a shift's start + grace can fall
 * just after midnight (a 23:55 start with ten minutes' grace), and "the last two hours"
 * at 00:30 reaches back into yesterday's 23:40. Each candidate is judged against the
 * date its shift began, and reminded with that date's dedupe key.
 *
 * Whether it is a WORKING DAY comes from the calendar — holiday, weekly off, approved
 * leave and employment dates in one place, the same answer the register and payroll
 * get. Only `upcoming` with no attendance at all qualifies: anything recorded, even a
 * day already closed, means they have been in.
 */
async function checkInReminders(now: Date): Promise<number> {
  const nowMs = now.getTime();
  const today = companyToday(now);
  const workDates = [addDays(today, -1), today];

  const candidates = await query<ShiftCandidateRow>(
    `SELECT u.id, TIME_FORMAT(s.starts_at, '%H:%i') AS starts_at, s.grace_minutes
       FROM hr_users u
       JOIN hr_shifts s ON s.id = u.shift_id
      WHERE u.is_active = 1 AND u.approval_status = 'approved'`,
  );

  // workDate -> people whose start + grace on that date fell inside the window.
  const due = new Map<string, Map<number, string>>();
  for (const row of candidates) {
    for (const workDate of workDates) {
      const at = companyInstant(workDate, row.starts_at, Number(row.grace_minutes));
      if (at <= nowMs && at > nowMs - CHECK_IN_WINDOW_MS) {
        const people = due.get(workDate) ?? new Map<number, string>();
        people.set(row.id, row.starts_at);
        due.set(workDate, people);
      }
    }
  }

  let written = 0;
  for (const [workDate, people] of due) {
    const ids = [...people.keys()];

    // Anyone with ANY open session is mid-shift (perhaps one that began yesterday).
    const open = new Set(
      (
        await query<RowDataPacket & { user_id: number }>(
          `SELECT user_id FROM hr_attendance_sessions
            WHERE ended_at IS NULL AND user_id IN (${ids.map(Number).join(',')})`,
        )
      ).map((row) => row.user_id),
    );

    // Grouped by start time, so each reminder can name the time it is about.
    const byStart = new Map<string, number[]>();
    for (let start = 0; start < ids.length; start += CALENDAR_BATCH) {
      const batch = ids.slice(start, start + CALENDAR_BATCH);
      // A working day with nothing recorded reads `yet_to_check_in` today (`upcoming` for a
      // later date) — the question is whether it is a working day, not how it ended.
      const calendars = await calendarForUsers(batch, workDate, workDate, { today: workDate });
      for (const userId of batch) {
        const day = calendars.get(userId)?.[0];
        const notIn = day?.status === 'yet_to_check_in' || day?.status === 'upcoming';
        if (!day || !notIn || day.attendance !== null || open.has(userId)) continue;
        const startsAt = people.get(userId)!;
        byStart.set(startsAt, [...(byStart.get(startsAt) ?? []), userId]);
      }
    }

    for (const [startsAt, userIds] of byStart) {
      written += await notifyHr({
        userIds,
        kind: 'check_in_reminder',
        title: 'Time to check in',
        body: `Your shift began at ${startsAt}. Check in from the app so your day is recorded.`,
        entityType: 'attendance_day',
        dedupeKey: `check_in:${workDate}`,
      });
    }
  }
  return written;
}

interface OpenSessionRow extends RowDataPacket {
  user_id: number;
  work_date: string;
  starts_at: string;
  ends_at: string;
}

/**
 * Check-out reminders, against the shift SNAPSHOT on the day row — the shift as it was
 * when they checked in, the same one lateness was measured against. A rota edited at
 * noon must not move the end of a day already under way.
 *
 * Yesterday is included for a night shift still running past midnight; anything older
 * is the sweep's business, not a reminder's.
 */
async function checkOutReminders(now: Date): Promise<number> {
  const nowMs = now.getTime();
  const today = companyToday(now);

  const rows = await query<OpenSessionRow>(
    `SELECT s.user_id,
            DATE_FORMAT(a.work_date, '%Y-%m-%d')     AS work_date,
            TIME_FORMAT(a.shift_starts_at, '%H:%i') AS starts_at,
            TIME_FORMAT(a.shift_ends_at, '%H:%i')   AS ends_at
       FROM hr_attendance_sessions s
       JOIN hr_attendance a ON a.id = s.attendance_id
       JOIN hr_users u ON u.id = s.user_id
      WHERE s.ended_at IS NULL
        AND a.work_date BETWEEN ? AND ?
        AND a.shift_starts_at IS NOT NULL AND a.shift_ends_at IS NOT NULL
        AND u.is_active = 1 AND u.approval_status = 'approved'`,
    [addDays(today, -1), today],
  );

  // (workDate, endsAt) -> people, so each reminder names its own shift end.
  const groups = new Map<string, { workDate: string; endsAt: string; userIds: number[] }>();
  for (const row of rows) {
    const end = shiftEndInstant(row.work_date, row.starts_at, row.ends_at);
    if (end === null || end + CHECK_OUT_AFTER_MS >= nowMs) continue;
    const key = `${row.work_date}|${row.ends_at}`;
    const group = groups.get(key) ?? { workDate: row.work_date, endsAt: row.ends_at, userIds: [] };
    group.userIds.push(row.user_id);
    groups.set(key, group);
  }

  let written = 0;
  for (const group of groups.values()) {
    written += await notifyHr({
      userIds: group.userIds,
      kind: 'check_out_reminder',
      title: 'Still checked in',
      body: `Your shift ended at ${group.endsAt} and you are still checked in. Check out when you finish so your hours are right.`,
      entityType: 'attendance_day',
      dedupeKey: `check_out:${group.workDate}`,
    });
  }
  return written;
}

/* -------------------------------------------------------------------------- */
/* The nightly verdict                                                         */
/* -------------------------------------------------------------------------- */

const JUDGED_ON_KEY = 'attendance_judged_on';

/**
 * Once a company day, on the first tick after midnight: every day that has ended gets its
 * verdict on the hours worked — full day, half day or absent (`dayJudge.ts`). A day is
 * never judged while it can still change: somebody who checked out at lunch may come back,
 * and somebody who started late may stay on past their shift to make up the hours.
 *
 * The date of the last pass is kept in `hr_settings`, so a restart does not run it twice
 * and a night the server was down is caught up on the next tick (the pass looks back 45
 * days). Two instances racing at midnight would both run it, harmlessly: it only writes
 * days whose verdict differs.
 */
async function judgeLastNight(now: Date): Promise<number> {
  const today = companyToday(now);
  const [last] = await query<RowDataPacket & { setting_value: string }>(
    'SELECT setting_value FROM hr_settings WHERE setting_key = ? LIMIT 1',
    [JUDGED_ON_KEY],
  );
  if (last?.setting_value === today) return 0;

  const judged = await judgeEndedDays();
  await execute(
    `INSERT INTO hr_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [JUDGED_ON_KEY, today],
  );
  return judged;
}

/* -------------------------------------------------------------------------- */
/* One tick                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One pass of every job. NEVER THROWS: each job is caught on its own, so a failing
 * reminder query does not stop the sweep, and the failures come back in the result for
 * the caller (the timer below, or the e2e harness, which calls this directly).
 *
 * `now` decides which shifts are due. The sweep's own staleness test runs in SQL against
 * the database clock, which is the clock the sessions were stamped with.
 */
export async function runHrSchedulerTick(now: Date = new Date()): Promise<HrTickResult> {
  const result: HrTickResult = {
    at: now.toISOString(),
    closedSessions: 0,
    checkInReminders: 0,
    checkOutReminders: 0,
    judgedDays: 0,
    failures: [],
  };

  /*
   * The nightly verdict first: the reminders read the calendar, and the days should carry
   * their verdicts before anything reads them.
   */
  const jobs: Array<[string, () => Promise<void>]> = [
    ['nightly_verdict', async () => void (result.judgedDays = await judgeLastNight(now))],
    ['sweep', async () => void (result.closedSessions = await sweepStaleSessions())],
    ['check_in_reminders', async () => void (result.checkInReminders = await checkInReminders(now))],
    ['check_out_reminders', async () => void (result.checkOutReminders = await checkOutReminders(now))],
  ];

  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (error) {
      result.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (result.closedSessions + result.checkInReminders + result.checkOutReminders + result.judgedDays > 0) {
    logger.info('HR scheduler tick', {
      closedSessions: result.closedSessions,
      checkInReminders: result.checkInReminders,
      checkOutReminders: result.checkOutReminders,
      judgedDays: result.judgedDays,
    });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* The timer                                                                   */
/* -------------------------------------------------------------------------- */

export type HrScheduler = {
  /** Stops new ticks at once, then waits for one already running to finish. */
  stop: () => Promise<void>;
};

export type HrSchedulerOptions = {
  tickMs?: number;
  firstDelayMs?: number;
  /** One tick's work; replaceable for tests. */
  run?: () => Promise<HrTickResult>;
};

let active: HrScheduler | null = null;

/**
 * Starts the schedule in this process. Calling it again while it runs returns the same
 * scheduler rather than starting a second clock.
 */
export function startHrScheduler(options: HrSchedulerOptions = {}): HrScheduler {
  if (active) return active;

  const tickMs = Math.max(options.tickMs ?? HR_TICK_MS, 1);
  const firstDelayMs = Math.max(options.firstDelayMs ?? HR_FIRST_DELAY_MS, 0);
  const run = options.run ?? (() => runHrSchedulerTick());

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let lastFailureLoggedAt: number | null = null;

  const logFailure = (detail: Record<string, unknown>): void => {
    // A database that is down for hours gives a warning every half hour, not every tick.
    const nowMs = Date.now();
    if (lastFailureLoggedAt !== null && nowMs - lastFailureLoggedAt < FAILURE_LOG_INTERVAL_MS) return;
    lastFailureLoggedAt = nowMs;
    logger.warn('HR scheduler tick failed', detail);
  };

  const tick = (): void => {
    // One at a time: a slow database must not stack a second sweep behind the first.
    if (stopped || inFlight) return;

    inFlight = (async () => {
      try {
        const outcome = await run();
        if (outcome.failures.length > 0) logFailure({ failures: outcome.failures });
        else lastFailureLoggedAt = null;
      } catch (error) {
        logFailure(describeError(error));
      } finally {
        inFlight = null;
      }
    })();
  };

  const first = setTimeout(tick, firstDelayMs);
  first.unref();
  const interval = setInterval(tick, tickMs);
  interval.unref();

  const scheduler: HrScheduler = {
    async stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(interval);
      if (inFlight) await inFlight;
      if (active === scheduler) active = null;
    },
  };

  active = scheduler;
  return scheduler;
}
