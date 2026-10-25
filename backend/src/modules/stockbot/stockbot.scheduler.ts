import { describeError, logger } from '../../utils/logger';
import { companyDate } from '../telecalling/companyTime';
import { loadStockbotSettings, maskClientCode } from './stockbot.config';
import { runTradingSession, type SessionOutcome } from './stockbot.service';

/**
 * The bot's clock, in process like the daily report's (see `dailyReport.scheduler.ts`
 * for why not cron or a systemd timer). Started by `server.ts` and never by
 * `createApp()`; on by default only in production (`STOCKBOT_SCHEDULER`), and even there
 * it stays off until the ANGEL_* credentials are valid.
 *
 * A tick every 30 seconds asks one question — should a session be running now? — and
 * starts one if so. The session itself decides from the clock and the database what to
 * do: capture, resume monitoring after a restart, or nothing because the day is done.
 * That is what makes a deploy at 11:00 harmless: the new process's first tick resumes
 * the day within a minute, and a break that happened in the gap is still caught, because
 * the feed's day high and low include it.
 *
 * Do not deploy between 09:10 and 09:16 IST. A restart across 09:15:30 loses that day's
 * opening range, and it cannot be rebuilt afterwards.
 */

const TICK_MS = 30_000;
const FIRST_DELAY_MS = 5_000;
/** After a failed session, before the next attempt. */
const RETRY_DELAY_MS = 60_000;
/** Another process holds the day; check again soon in case it died. */
const BUSY_DELAY_MS = 15_000;

export type StockbotScheduler = {
  /** Stops ticking, ends a running session (feed closed, lease released, logged out). */
  stop(): Promise<void>;
};

let active: StockbotScheduler | null = null;

export function startStockbotScheduler(): StockbotScheduler | null {
  if (active) return active;

  const loaded = loadStockbotSettings();
  if (!loaded.ok) {
    if (loaded.configured) {
      logger.error('Stock bot is configured but its settings are invalid; it will not run', {
        problems: loaded.problems,
      });
    } else {
      logger.info('Stock bot: not configured (no ANGEL_* credentials); scheduler idle');
    }
    return null;
  }
  const { settings } = loaded;
  logger.info('Stock bot: scheduler on', {
    client: maskClientCode(settings.clientCode),
    staticIps: settings.staticIps,
    dataDirectory: settings.dataDirectory,
    emails: settings.emailsEnabled ? 'on' : 'off',
  });

  const controller = new AbortController();
  let running: Promise<void> | null = null;
  let notBefore = 0;
  /** The IST date whose session has ended for good, so ticks skip the database. */
  let doneFor: string | null = null;

  const settle = (outcome: SessionOutcome) => {
    switch (outcome.kind) {
      case 'final':
      case 'ran':
        doneFor = companyDate();
        break;
      case 'retry':
        notBefore = Date.now() + RETRY_DELAY_MS;
        break;
      case 'busy':
        notBefore = Date.now() + BUSY_DELAY_MS;
        break;
      default:
        break;
    }
  };

  const tick = (): void => {
    if (controller.signal.aborted || running || Date.now() < notBefore) return;
    if (doneFor === companyDate()) return;

    running = runTradingSession(settings, controller.signal)
      .then(settle)
      .catch((error: unknown) => {
        // runTradingSession is written not to reject; this is the backstop that keeps
        // the API process alive if it ever does.
        logger.error('Stock bot: session crashed', describeError(error));
        notBefore = Date.now() + RETRY_DELAY_MS;
      })
      .finally(() => {
        running = null;
      });
  };

  const first = setTimeout(tick, FIRST_DELAY_MS);
  first.unref();
  const interval = setInterval(tick, TICK_MS);
  interval.unref();

  const scheduler: StockbotScheduler = {
    async stop() {
      clearTimeout(first);
      clearInterval(interval);
      controller.abort();
      if (running) await running;
      if (active === scheduler) active = null;
    },
  };
  active = scheduler;
  return scheduler;
}
