import { describeError, logger } from '../../../utils/logger';
import type { RunOutcome } from './dailyReport.schema';
import { runDueDailyReport, setDailyReportSchedulerRunning } from './dailyReport.service';

/**
 * The clock behind the daily telecalling report — the API's one piece of scheduled work.
 *
 * In process, started by `server.ts` and NEVER by `createApp()`: the e2e harness and
 * anything else that imports the app must get no timers. Off by default outside
 * production (`TELECALLING_REPORT_SCHEDULER`).
 *
 * It holds no state worth losing. Each tick asks the database whether a report is due and
 * whether anyone has sent it (`runDueDailyReport`), so a restart, a deploy or a second
 * server changes nothing: the day is claimed once, by whichever process gets there first.
 * A tick every five minutes means the email lands within minutes of its time, and a
 * server that was down at 08:00 catches up when it returns.
 *
 * Why not cron or a systemd timer: one more thing to install and to forget on the next
 * host, and it would need the same database claim anyway. Why not one long setTimeout to
 * the exact minute: it drifts across suspend and clock changes, and has no natural
 * catch-up after a restart.
 *
 * It must never take the process down — `server.ts` exits on an uncaught exception — so
 * every tick swallows its own failure, and a database that is down for hours produces a
 * warning every half hour rather than one every five minutes.
 */

export const DEFAULT_TICK_MS = 5 * 60_000;
export const DEFAULT_FIRST_DELAY_MS = 30_000;

/** While ticks keep failing, say so at most this often. */
const FAILURE_LOG_INTERVAL_MS = 30 * 60_000;

export type TelecallingReportScheduler = {
  /** Stops new ticks at once, then waits for one already running to finish. */
  stop(): Promise<void>;
};

export type SchedulerOptions = {
  /** Between ticks. Default five minutes. */
  tickMs?: number;
  /** Before the first tick, so a booting server is up before it does any work. */
  firstDelayMs?: number;
  /** One tick's work. Default `runDueDailyReport()`; replaceable for tests. */
  run?: () => Promise<RunOutcome>;
};

let active: TelecallingReportScheduler | null = null;

/** Routine outcomes are debug noise every five minutes; a run logs its own result. */
function logOutcome(outcome: RunOutcome): void {
  if (outcome.kind === 'ran' || outcome.kind === 'interrupted') return;
  logger.debug('Daily telecalling report tick', {
    outcome: outcome.kind,
    ...('reportDate' in outcome ? { reportDate: outcome.reportDate } : {}),
  });
}

/**
 * Starts the schedule in this process. Calling it again while it runs returns the same
 * scheduler rather than starting a second clock.
 */
export function startTelecallingReportScheduler(
  options: SchedulerOptions = {},
): TelecallingReportScheduler {
  if (active) return active;

  const tickMs = Math.max(options.tickMs ?? DEFAULT_TICK_MS, 1);
  const firstDelayMs = Math.max(options.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS, 0);
  const run = options.run ?? (() => runDueDailyReport());

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let lastFailureLoggedAt: number | null = null;

  const tick = (): void => {
    // One tick at a time: a slow mail server must not stack a second send attempt behind
    // the first. The database claim would refuse it anyway; this saves the query.
    if (stopped || inFlight) return;

    inFlight = (async () => {
      try {
        logOutcome(await run());
        lastFailureLoggedAt = null;
      } catch (error) {
        const now = Date.now();
        if (lastFailureLoggedAt === null || now - lastFailureLoggedAt >= FAILURE_LOG_INTERVAL_MS) {
          lastFailureLoggedAt = now;
          logger.warn('Daily report tick failed', describeError(error));
        }
      } finally {
        inFlight = null;
      }
    })();
  };

  // Both unref'd: the schedule must never be the reason the process stays alive.
  const first = setTimeout(tick, firstDelayMs);
  first.unref();
  const interval = setInterval(tick, tickMs);
  interval.unref();

  const scheduler: TelecallingReportScheduler = {
    async stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(interval);
      if (inFlight) await inFlight;
      if (active === scheduler) {
        active = null;
        setDailyReportSchedulerRunning(false);
      }
    },
  };

  active = scheduler;
  setDailyReportSchedulerRunning(true);
  return scheduler;
}
