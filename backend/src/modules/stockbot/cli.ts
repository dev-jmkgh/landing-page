import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { companyDate } from '../telecalling/companyTime';
import { MarketFeed, planConnections } from './feed';
import { loadInstruments } from './instruments';
import { fetchHoldings, login, logout, type AngelSession } from './smartapi.client';
import { loadStockbotSettings, maskClientCode } from './stockbot.config';
import { isWeekday, marketTimes, type QuotePacket } from './stockbot.schema';
import { buildTargetList, readWatchlists } from './targets';

/**
 * Operator commands for the opening-range breakout bot.
 *
 *   npm run stockbot:prod -- check      prove the whole path works, end to end
 *   npm run stockbot:prod -- status     what the bot did today (database only)
 *
 * (`npm run stockbot -- …` runs the same from src with tsx, for development.)
 *
 * `check` logs in, reads the holdings and watchlists, builds the target list, opens the
 * market feed for a few seconds and reports what arrived, then logs out. It writes
 * nothing to the database and sends no email. It refuses during market hours on a
 * weekday, because a second login can disturb the running session; `--force` overrides.
 */

const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const line = (text = '') => console.log(text);
const fail = (text: string): never => {
  console.error(`\n  FAILED: ${text}\n`);
  process.exit(1);
};

async function check(args: string[]): Promise<void> {
  const seconds = Number(args.find((arg) => arg.startsWith('--seconds='))?.split('=')[1] ?? 15);
  const force = args.includes('--force');

  line('\nStock bot — check\n');
  const loaded = loadStockbotSettings();
  if (!loaded.ok) fail(`settings: ${loaded.problems.join('; ')}`);
  if (!loaded.ok) return;
  const { settings } = loaded;

  line(`  client           ${maskClientCode(settings.clientCode)}`);
  line(`  static IPs       ${settings.staticIps.join(', ') || '(none set)'}`);
  line(`  data directory   ${settings.dataDirectory}`);
  const watchlistExists = await fs.access(settings.watchlistFile).then(
    () => true,
    () => false,
  );
  line(`  watchlists.json  ${watchlistExists ? 'present' : 'none (optional: extra stocks beyond holdings and F&O)'}`);

  const today = companyDate();
  const times = marketTimes(today);
  const now = Date.now();
  const marketHours = isWeekday(today) && now >= times.sessionStart.getTime() && now < times.close.getTime() + 5 * 60_000;
  if (marketHours && !force) {
    fail('it is market hours, and a second login can disturb the running session. Use `status`, or pass --force.');
  }

  let session: AngelSession | null = null;
  try {
    session = await login(settings);
    const angel = session;
    line(`  login            ok`);
    line(
      `  public IP        ${session.publicIp ?? 'unknown'} — orders ${
        session.ordersAllowed === true ? 'allowed from here' : session.ordersAllowed === false ? 'NOT allowed from here' : 'unknown'
      }`,
    );

    const holdings = await fetchHoldings(session);
    line(`  holdings         ${holdings.length}`);

    const index = await loadInstruments(settings.cacheDirectory);
    line(`  instruments      ${index.size} NSE/BSE cash instruments`);

    line(`  F&O stocks       ${index.fnoStocks().instruments.length}`);

    const watchlists = await readWatchlists(settings.watchlistFile);
    const targets = buildTargetList(holdings, watchlists, index, settings.preferredExchange);
    line(`  watchlists       ${Object.keys(watchlists).length} (${Object.values(watchlists).flat().length} entries)`);
    line(`  targets          ${targets.targets.size} unique instruments`);
    for (const entry of targets.unresolved) line(`    not resolved:  ${entry}`);
    // Thrown, not fail(): process.exit inside this try would skip the logout below.
    if (targets.targets.size === 0) throw new Error('nothing to track: no holdings, no F&O stocks and no watchlist entries');

    const symbols = new Map([...targets.targets.values()].map(({ instrument }) => [`${instrument.exchange}:${instrument.token}`, instrument.symbol]));
    const latest = new Map<string, QuotePacket>();
    let packets = 0;
    const feed = new MarketFeed({
      plans: planConnections([...targets.targets.values()].map(({ instrument }) => instrument)),
      credentials: () => ({
        authorization: `Bearer ${angel.jwtToken}`,
        apiKey: angel.apiKey,
        clientCode: angel.clientCode,
        feedToken: angel.feedToken,
      }),
      onPacket: (packet) => {
        packets += 1;
        latest.set(`${packet.exchange}:${packet.token}`, packet);
      },
    });

    line(`\n  listening to the market feed for ${seconds}s ...`);
    feed.start();
    await sleep(seconds * 1000);
    const stats = feed.stats();
    feed.stop();

    line(`  feed             ${stats.connected} connection(s) open, ${packets} packets, ${latest.size}/${targets.targets.size} instruments heard from`);
    // One packet from each segment first (an option priced in the wrong unit would show
    // here), then fill up to eight.
    const received = [...latest.values()];
    const firstPerSegment = [...new Map(received.map((packet) => [packet.exchange, packet])).values()];
    const samples = [...new Set([...firstPerSegment, ...received])].slice(0, 8);
    for (const packet of samples) {
      const symbol = symbols.get(`${packet.exchange}:${packet.token}`) ?? packet.token;
      line(
        `    ${symbol.padEnd(18)} last ${packet.lastPrice.toFixed(2).padStart(10)}  ` +
          `day ${String(packet.dayLow ?? '—').padStart(9)} – ${String(packet.dayHigh ?? '—').padEnd(9)}  ` +
          `sent ${IST_TIME.format(packet.exchangeTime)}  last trade ${packet.lastTradeTime ? IST_TIME.format(packet.lastTradeTime) : '—'}`,
      );
    }
    if (stats.connected === 0 && packets === 0) throw new Error('the market feed did not connect — see the log lines above');
    if (packets === 0) line('  (no packets: normal outside market hours; the connection itself worked)');

    line('\n  check passed\n');
  } finally {
    if (session) await logout(session);
  }
}

async function status(args: string[]): Promise<void> {
  const tradeDate = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? companyDate();
  // Loaded here so `check` never opens a database connection.
  const repo = await import('./stockbot.repository');
  const { closePool } = await import('../../db/pool');

  try {
    const day = await repo.findDay(tradeDate);
    line(`\nStock bot — ${tradeDate}\n`);
    if (!day) {
      line('  no session recorded for this day\n');
      return;
    }
    line(`  status          ${day.status}${day.lastError ? ` (${day.lastError})` : ''}`);
    line(`  attempts        ${day.attempts}`);
    line(`  targets         ${day.targetCount ?? '—'}`);
    line(`  levels          ${day.levelsOk ?? '—'} set, ${day.levelsMissing ?? '—'} without data`);
    line(`  running on      ${day.leaseExpiresAt ? day.runnerLabel : '(nobody)'}`);

    const levels = await repo.loadLevels(tradeDate);
    if (levels.length > 0) {
      line('\n  levels (09:15:00–09:15:30 IST)');
      for (const level of levels) {
        line(
          `    ${level.symbol.padEnd(18)} ${level.exchange}  ` +
            (level.status === 'ok' ? `high ${level.high?.toFixed(2)}  low ${level.low?.toFixed(2)}` : 'no trade in the window'),
        );
      }
    }

    const breakouts = await repo.listBreakouts(tradeDate);
    line(`\n  breakouts       ${breakouts.length}`);
    for (const item of breakouts) {
      line(
        `    ${IST_TIME.format(item.detectedAt)}  ${item.symbol.padEnd(18)} ${item.direction === 'up' ? 'above' : 'below'} ` +
          `${item.level.toFixed(2)} at ${item.price.toFixed(2)}${item.alertedAt ? '' : '  (alert pending)'}`,
      );
    }
    line();
  } finally {
    await closePool();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'check') await check(args);
  else if (command === 'status') await status(args);
  else {
    console.error('Usage: stockbot <check [--seconds=15] [--force] | status [YYYY-MM-DD]>');
    process.exit(2);
  }
  // fetch keeps idle sockets alive for a while; nothing else is pending.
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
