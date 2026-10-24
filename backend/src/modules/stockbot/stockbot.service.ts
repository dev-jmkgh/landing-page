import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { sendAdminNotification, type AdminNotificationInput, type MailResult } from '../../services/mailer';
import { stockbotBreakoutsEmail, stockbotLevelsEmail, stockbotNoticeEmail } from '../../services/email';
import { logger } from '../../utils/logger';
import { companyDate } from '../telecalling/companyTime';
import { MarketFeed, planConnections, type FeedStats, type MarketFeedOptions } from './feed';
import { loadInstruments, type InstrumentIndex } from './instruments';
import { BreakoutDetector, OpeningRangeCapture } from './openingRange';
import {
  AngelRefusedError,
  fetchHoldings,
  login,
  logout,
  type AngelSession,
} from './smartapi.client';
import type { StockbotSettings } from './stockbot.config';
import * as repo from './stockbot.repository';
import {
  FINAL_DAY_STATUSES,
  isWeekday,
  marketTimes,
  type DayStatus,
  type FrozenLevel,
  type MarketTimes,
  type QuotePacket,
} from './stockbot.schema';
import { buildTargetList, readWatchlists } from './targets';

/**
 * Everything the session reaches outside the database. Production uses the real ones;
 * the e2e section replaces them to run whole trading days in seconds, with a scripted
 * feed and a recording mailer, against the scratch database.
 */
export type SessionDeps = {
  tradeDate: () => string;
  times: (tradeDate: string) => MarketTimes;
  login: (settings: StockbotSettings, signal?: AbortSignal) => Promise<AngelSession>;
  logout: (session: AngelSession) => Promise<void>;
  fetchHoldings: typeof fetchHoldings;
  loadInstruments: (cacheDirectory: string, signal?: AbortSignal) => Promise<InstrumentIndex>;
  readWatchlists: typeof readWatchlists;
  createFeed: (options: MarketFeedOptions) => { start(): void; stop(): void; stats(): FeedStats };
  notify: (input: AdminNotificationInput) => Promise<MailResult>;
};

const productionDeps: SessionDeps = {
  tradeDate: () => companyDate(),
  times: marketTimes,
  login,
  logout,
  fetchHoldings,
  loadInstruments,
  readWatchlists,
  createFeed: (options) => new MarketFeed(options),
  notify: sendAdminNotification,
};

/**
 * One trading day, start to finish:
 *
 *   09:00  claim the day, log in, build the target list, subscribe to the feed
 *   09:15  record every packet stamped inside [09:15:00, 09:15:30)
 *   09:15:33  freeze and save the levels, email them
 *   ...    report the first break above each high and below each low
 *   15:30  close the feed, log out, mark the day closed
 *
 * Started by the scheduler, never directly by a request. Everything it must not lose
 * across a restart is in the database: a session that starts after 09:15:30 loads the
 * saved levels and goes straight to monitoring. Ownership is a lease on the day's row,
 * renewed while the session runs, so two API processes never both trade a day.
 */

/** Long enough to survive a slow database; short enough that a crashed process's
 *  successor can take over within a minute. */
const LEASE_SECONDS = 45;
const LEASE_RENEW_MS = 15_000;
const ALERT_FLUSH_MS = 60_000;
/**
 * The feed asks for a fresh login when the socket refuses our session; it reconnects
 * every few seconds, so without a floor a persistent refusal would mean a login attempt
 * every reconnect.
 */
const RELOGIN_MIN_INTERVAL_MS = 5 * 60_000;

export type SessionOutcome =
  | { kind: 'idle'; reason: 'weekend' | 'outside_hours' }
  | { kind: 'final'; status: DayStatus }
  | { kind: 'busy' }
  | { kind: 'interrupted' }
  | { kind: 'retry'; error: string }
  | { kind: 'ran'; status: DayStatus };

async function sleepUntil(at: Date, signal: AbortSignal): Promise<void> {
  const wait = at.getTime() - Date.now();
  if (wait > 0) await sleep(wait, undefined, { signal });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Notify = SessionDeps['notify'];

/** Sends the day's one notice ("did not run because ..."), at most once. */
async function sendNoticeOnce(notify: Notify, tradeDate: string, heading: string, lines: string[]): Promise<void> {
  if (!(await repo.claimDayEmail(tradeDate, 'notice'))) return;
  const email = stockbotNoticeEmail({ tradeDate, heading, lines });
  await notify({ ...email, type: 'stockbot-notice' });
}

async function sendLevelsOnce(
  notify: Notify,
  tradeDate: string,
  levels: FrozenLevel[],
  unresolved: string[],
): Promise<void> {
  if (!(await repo.claimDayEmail(tradeDate, 'levels'))) return;
  const email = stockbotLevelsEmail({
    tradeDate,
    levels: levels
      .filter((level) => level.status === 'ok')
      .map(({ symbol, exchange, high, low, sources }) => ({ symbol, exchange, high, low, sources })),
    missing: levels
      .filter((level) => level.status === 'no_data')
      .map(({ symbol, exchange }) => ({ symbol, exchange })),
    unresolved,
  });
  await notify({ ...email, type: 'stockbot-levels' });
}

/**
 * Mails every break recorded since the last flush, as one message. A failed send hands
 * the rows back, so the next flush tries again; "skipped" (mail not configured) settles
 * them — the breaks are in the database either way.
 */
async function flushAlerts(notify: Notify, tradeDate: string): Promise<void> {
  const claim = randomUUID();
  const breakouts = await repo.claimAlerts(tradeDate, claim);
  if (breakouts.length === 0) return;

  const email = stockbotBreakoutsEmail({ tradeDate, breakouts });
  const result = await notify({ ...email, type: 'stockbot-breakouts' });
  if (result === 'failed') {
    await repo.releaseAlerts(claim);
    logger.warn('Stock bot: breakout alert not delivered; will retry', { breakouts: breakouts.length });
    return;
  }
  await repo.settleAlerts(claim);
}

/**
 * Runs (or resumes) today's session if one is due. Resolves when the day is over, the
 * signal aborts, or a failure needs a retry; never rejects.
 */
export async function runTradingSession(
  settings: StockbotSettings,
  signal: AbortSignal,
  overrides: Partial<SessionDeps> = {},
): Promise<SessionOutcome> {
  const deps: SessionDeps = { ...productionDeps, ...overrides };
  const { notify } = deps;
  const tradeDate = deps.tradeDate();
  if (!isWeekday(tradeDate)) return { kind: 'idle', reason: 'weekend' };
  const times = deps.times(tradeDate);
  const now = Date.now();
  if (now < times.sessionStart.getTime() || now >= times.close.getTime()) {
    return { kind: 'idle', reason: 'outside_hours' };
  }

  const day = await repo.ensureDay(tradeDate);
  if (FINAL_DAY_STATUSES.includes(day.status)) return { kind: 'final', status: day.status };

  const runner = randomUUID();
  const label = `${os.hostname()}:${process.pid}`.slice(0, 120);
  if (!(await repo.claimDay(tradeDate, runner, label, LEASE_SECONDS))) return { kind: 'busy' };

  // The session's own stop: the scheduler's signal, or losing the lease.
  const controller = new AbortController();
  const stopOnOuter = () => controller.abort();
  signal.addEventListener('abort', stopOnOuter, { once: true });
  const session = controller.signal;

  const leaseTimer = setInterval(() => {
    repo
      .renewLease(tradeDate, runner, LEASE_SECONDS)
      .then((held) => {
        if (!held) {
          logger.error('Stock bot: lost the day lease to another process; stopping this session');
          controller.abort();
        }
      })
      .catch((error: unknown) => logger.warn('Stock bot: lease renewal failed', { reason: reasonOf(error) }));
  }, LEASE_RENEW_MS);
  leaseTimer.unref();

  let angel: AngelSession | null = null;
  /** Set when a mid-day re-login is refused: the session must end, not keep trying. */
  let refusedRelogin: AngelRefusedError | null = null;
  let feed: ReturnType<SessionDeps['createFeed']> | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;

  const finish = async (status: DayStatus, lastError: string | null = null): Promise<SessionOutcome> => {
    await repo.updateDay(tradeDate, runner, { status, lastError, finished: true });
    logger.info('Stock bot: day finished', { tradeDate, status, ...(lastError ? { reason: lastError } : {}) });
    return { kind: 'ran', status };
  };

  try {
    await repo.updateDay(tradeDate, runner, { lastError: null });

    // Too late to capture: resume from saved levels, or give up on today.
    let levels: FrozenLevel[] | null = null;
    if (Date.now() >= times.freezeAt.getTime()) {
      levels = await repo.loadLevels(tradeDate);
      if (levels.length === 0) {
        await sendNoticeOnce(notify, tradeDate, 'no breakout alerts today', [
          'The bot was not running at 09:15, so there is no opening range for today.',
          'This happens when the server was down or restarting at the open. It will run again tomorrow.',
        ]);
        return await finish('missed', 'Started after 09:15:30 with no levels saved.');
      }
      logger.info('Stock bot: resuming with saved levels', { tradeDate, levels: levels.length });
    }

    angel = await deps.login(settings, session);
    const currentAngel = () => angel as AngelSession;

    let unresolved: string[] = [];
    let instruments: { exchange: FrozenLevel['exchange']; token: string }[];
    let capture: OpeningRangeCapture | null = null;
    let targets: ReturnType<typeof buildTargetList> | null = null;

    if (!levels) {
      const index = await deps.loadInstruments(settings.cacheDirectory, session);
      const holdings = await deps.fetchHoldings(angel, session);
      const watchlists = await deps.readWatchlists(settings.watchlistFile);
      targets = buildTargetList(holdings, watchlists, index, settings.preferredExchange);
      unresolved = targets.unresolved;

      logger.info('Stock bot: target list', {
        tradeDate,
        instruments: targets.targets.size,
        holdings: holdings.length,
        watchlists: Object.keys(watchlists).length,
        unresolved: unresolved.length,
      });
      for (const entry of unresolved) logger.warn('Stock bot: not tracked, could not resolve', { entry });

      if (targets.targets.size === 0) {
        await sendNoticeOnce(notify, tradeDate, 'nothing to track', [
          'No holdings, no F&O stocks in the instrument list, and no extra stocks in watchlists.json.',
          ...(unresolved.length > 0 ? [`Unmatched entries: ${unresolved.join('; ')}`] : []),
        ]);
        return await finish('failed', 'No instruments to track.');
      }

      instruments = [...targets.targets.values()].map(({ instrument }) => instrument);
      capture = new OpeningRangeCapture(times.rangeStart, times.rangeEnd, times.sessionStart);
      await repo.updateDay(tradeDate, runner, { status: 'capturing', targetCount: targets.targets.size });
    } else {
      instruments = levels.filter((level) => level.status === 'ok');
    }

    // One handler for the whole day, switched from capturing to monitoring at the freeze.
    let onPacket: (packet: QuotePacket) => void = (packet) => capture?.add(packet);

    feed = deps.createFeed({
      plans: planConnections(instruments),
      credentials: () => ({
        authorization: `Bearer ${currentAngel().jwtToken}`,
        apiKey: currentAngel().apiKey,
        clientCode: currentAngel().clientCode,
        feedToken: currentAngel().feedToken,
      }),
      onPacket: (packet) => onPacket(packet),
      onAuthRejected: async () => {
        if (refusedRelogin || Date.now() - currentAngel().loggedInAt.getTime() < RELOGIN_MIN_INTERVAL_MS) return;
        try {
          angel = await deps.login(settings, session);
        } catch (error) {
          // A refusal here is a credential problem (a changed PIN, a revoked key). Every
          // further attempt counts towards Angel's lockout, so end the session instead.
          if (error instanceof AngelRefusedError) {
            refusedRelogin = error;
            controller.abort();
          }
          throw error;
        }
      },
    });
    feed.start();

    if (!levels && capture && targets) {
      await sleepUntil(times.freezeAt, session);
      levels = capture.freeze(targets.targets.values());
      await repo.saveLevels(tradeDate, levels);

      const ok = levels.filter((level) => level.status === 'ok').length;
      const missing = levels.length - ok;
      logger.info('Stock bot: opening range frozen', { tradeDate, ok, missing, feed: feed.stats() });

      if (ok === 0) {
        await sendNoticeOnce(notify, tradeDate, 'no market data this morning', [
          'None of the tracked stocks traded between 09:15:00 and 09:15:30 IST.',
          'Usually this is an exchange holiday. If the market was open, the market-data feed did not reach the server — check the API log for "Stock bot".',
        ]);
        return await finish('no_data', 'No packets inside the opening window.');
      }

      await repo.updateDay(tradeDate, runner, { status: 'monitoring', levelsOk: ok, levelsMissing: missing, frozen: true });
      void sendLevelsOnce(notify, tradeDate, levels, unresolved).catch((error: unknown) =>
        logger.warn('Stock bot: levels email failed', { reason: reasonOf(error) }),
      );
    } else {
      await repo.updateDay(tradeDate, runner, { status: 'monitoring' });
    }

    // Both branches above set it; the check is for the type system and for future edits.
    if (!levels) throw new Error('no levels after the opening window');
    const detector = new BreakoutDetector(levels, times.rangeEnd, await repo.firedBreakoutKeys(tradeDate));
    await repo.releaseAbandonedAlerts(tradeDate);
    logger.info('Stock bot: watching for breakouts', { tradeDate, instruments: detector.watching });

    onPacket = (packet) => {
      for (const event of detector.check(packet)) {
        logger.info('Stock bot: breakout', {
          symbol: event.symbol,
          direction: event.direction,
          level: event.level,
          price: event.price,
        });
        repo
          .insertBreakout(tradeDate, event)
          .catch((error: unknown) => logger.error('Stock bot: could not record a breakout', { reason: reasonOf(error) }));
      }
    };

    const flush = () => {
      if (flushing) return;
      flushing = flushAlerts(notify, tradeDate)
        .catch((error: unknown) => logger.warn('Stock bot: alert flush failed', { reason: reasonOf(error) }))
        .finally(() => {
          flushing = null;
        });
    };
    flushTimer = setInterval(flush, ALERT_FLUSH_MS);
    flushTimer.unref();

    await sleepUntil(times.close, session);

    // Catch the last minute's breaks before closing the day.
    if (flushing) await flushing;
    await flushAlerts(notify, tradeDate);
    logger.info('Stock bot: market closed', { tradeDate, feed: feed.stats() });
    return await finish('closed');
  } catch (caught) {
    const error: unknown = refusedRelogin ?? caught;
    if (session.aborted && !refusedRelogin) {
      // A shutdown or a lost lease, not a failure: the day stays open for whoever runs next.
      logger.info('Stock bot: session stopped', { tradeDate });
      return { kind: 'interrupted' };
    }
    if (error instanceof AngelRefusedError && error.what === 'login') {
      // Retrying a refused login all day is how an account gets locked. Stop for today.
      await sendNoticeOnce(notify, tradeDate, 'Angel One refused the login', [
        `Angel said: ${error.code ?? 'no code'} — ${error.detail}`,
        'The bot will not try again today. Check ANGEL_CLIENT_ID, ANGEL_PIN, ANGEL_TOTP_SECRET and ANGEL_API_KEY in the server .env.',
      ]).catch(() => undefined);
      return await finish('failed', `Login refused: ${error.code ?? 'no code'}`).catch(
        () => ({ kind: 'retry', error: reasonOf(error) }) as SessionOutcome,
      );
    }
    const reason = reasonOf(error);
    logger.error('Stock bot: session failed; will retry', { tradeDate, reason });
    await repo.updateDay(tradeDate, runner, { lastError: reason }).catch(() => undefined);
    return { kind: 'retry', error: reason };
  } finally {
    signal.removeEventListener('abort', stopOnOuter);
    clearInterval(leaseTimer);
    if (flushTimer) clearInterval(flushTimer);
    feed?.stop();
    await repo.releaseLease(tradeDate, runner).catch(() => undefined);
    if (angel) await deps.logout(angel);
  }
}
