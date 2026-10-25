/**
 * The opening-range breakout bot (modules/stockbot).
 *
 * The bot has no HTTP surface and talks to Angel One over the network, so this section
 * drives its pure parts directly — TOTP, packet decoding, the 30-second window, breakout
 * detection, the target merge — and its repository against the scratch database: the day
 * lease, the at-most-once email claims and the alert claim cycle that make a restart
 * mid-session safe. Nothing here touches the network.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { E2EContext } from './context';

/** A QUOTE packet exactly as SmartStream sends it. Prices in rupees here, paise on the wire. */
function quotePacket(options: {
  exchangeType?: number;
  token: string;
  at: number;
  last: number;
  open?: number;
  high?: number;
  low?: number;
  mode?: number;
  /** SNAP_QUOTE's last-traded time, epoch ms or seconds. */
  lastTraded?: number;
}): Buffer {
  const mode = options.mode ?? 2;
  const buffer = Buffer.alloc(mode === 1 ? 51 : mode === 3 ? 379 : 123);
  if (mode === 3) buffer.writeBigInt64LE(BigInt(options.lastTraded ?? 0), 123);
  buffer.writeUInt8(mode, 0);
  buffer.writeUInt8(options.exchangeType ?? 1, 1);
  buffer.write(options.token, 2, 'ascii');
  buffer.writeBigInt64LE(42n, 27);
  buffer.writeBigInt64LE(BigInt(options.at), 35);
  buffer.writeBigInt64LE(BigInt(Math.round(options.last * 100)), 43);
  if (mode !== 1) {
    buffer.writeBigInt64LE(BigInt(Math.round((options.open ?? 0) * 100)), 91);
    buffer.writeBigInt64LE(BigInt(Math.round((options.high ?? 0) * 100)), 99);
    buffer.writeBigInt64LE(BigInt(Math.round((options.low ?? 0) * 100)), 107);
  }
  return buffer;
}

export async function run(ctx: E2EContext): Promise<void> {
  const { check } = ctx;
  const totp = await import('../../src/modules/stockbot/totp');
  const feed = await import('../../src/modules/stockbot/feed');
  const schema = await import('../../src/modules/stockbot/stockbot.schema');
  const range = await import('../../src/modules/stockbot/openingRange');
  const targetsModule = await import('../../src/modules/stockbot/targets');
  const { InstrumentIndex } = await import('../../src/modules/stockbot/instruments');
  const repo = await import('../../src/modules/stockbot/stockbot.repository');
  const { loadStockbotSettings } = await import('../../src/modules/stockbot/stockbot.config');
  const email = await import('../../src/services/email');

  /* ----------------------------------------------------------------- TOTP */
  console.log('\nstockbot — TOTP (RFC 6238 test vectors)');
  // The RFC's SHA-1 seed is the ASCII "12345678901234567890"; this is its base32.
  const seed = totp.base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  check('the base32 seed decodes to the RFC key', seed.toString('ascii') === '12345678901234567890');
  check('T=59s gives 94287082', totp.totpAt(seed, 59_000, 8) === '94287082', totp.totpAt(seed, 59_000, 8));
  check('T=1111111109 gives 07081804', totp.totpAt(seed, 1_111_111_109_000, 8) === '07081804');
  check('T=2000000000 gives 69279037', totp.totpAt(seed, 2_000_000_000_000, 8) === '69279037');
  check('six digits are the last six', totp.totpAt(seed, 59_000) === '287082');
  check('spaces, padding and case in a secret are ignored', totp.base32Decode('gezd gnbv gy3t qojq====').equals(totp.base32Decode('GEZDGNBVGY3TQOJQ')));
  let rejected = false;
  try {
    totp.base32Decode('NOT-BASE32!');
  } catch {
    rejected = true;
  }
  check('a non-base32 secret is rejected', rejected);

  /* ------------------------------------------------------- packet decoding */
  console.log('\nstockbot — SmartStream packet decoding');
  const tradeDate = '2026-10-23'; // a Friday
  const times = schema.marketTimes(tradeDate);
  check('the window starts at 09:15:00 IST', times.rangeStart.toISOString() === '2026-10-23T03:45:00.000Z');
  check('the window ends at 09:15:30 IST', times.rangeEnd.toISOString() === '2026-10-23T03:45:30.000Z');
  check('levels freeze 3 s after the window', times.freezeAt.getTime() - times.rangeEnd.getTime() === 3_000);
  check('the session closes at 15:30 IST', times.close.toISOString() === '2026-10-23T10:00:00.000Z');
  check('Friday is a trading weekday', schema.isWeekday('2026-10-23'));
  check('Saturday is not', !schema.isWeekday('2026-10-24'));

  const t = (offsetMs: number) => times.rangeStart.getTime() + offsetMs;
  const decoded = feed.parsePacket(quotePacket({ token: '2885', at: t(5_000), last: 2951.2, open: 2930, high: 2960, low: 2925.5 }));
  check('a QUOTE packet decodes', decoded !== null, decoded);
  check('exchange and token', decoded?.exchange === 'NSE' && decoded?.token === '2885', decoded);
  check('paise become rupees', decoded?.lastPrice === 2951.2 && decoded?.dayHigh === 2960 && decoded?.dayLow === 2925.5, decoded);
  check('the exchange timestamp is kept', decoded?.exchangeTime.getTime() === t(5_000));
  const bse = feed.parsePacket(quotePacket({ exchangeType: 3, token: '500325', at: t(0), last: 10 }));
  check('exchange type 3 is BSE', bse?.exchange === 'BSE');
  const ltpOnly = feed.parsePacket(quotePacket({ token: '1', at: t(0), last: 5, mode: 1 }));
  check('an LTP-only packet has no day figures', ltpOnly !== null && ltpOnly.dayHigh === null && ltpOnly.dayLow === null, ltpOnly);
  const noTrade = feed.parsePacket(quotePacket({ token: '1', at: t(0), last: 5 }));
  check('a zero day high means "no trade yet", not a price of 0', noTrade?.dayHigh === null && noTrade?.open === null);
  const snap = feed.parsePacket(quotePacket({ token: '2885', at: t(5_000), last: 100, high: 101, low: 99, mode: 3, lastTraded: t(4_000) }));
  check('a SNAP_QUOTE packet carries the last-traded time', snap?.lastTradeTime?.getTime() === t(4_000), snap?.lastTradeTime);
  check('a QUOTE packet has none', decoded?.lastTradeTime === null);
  const snapSeconds = feed.parsePacket(quotePacket({ token: '2885', at: t(0), last: 1, mode: 3, lastTraded: Math.floor(t(4_000) / 1000) }));
  check('a last-traded time in seconds is scaled too', snapSeconds?.lastTradeTime?.getTime() === Math.floor(t(4_000) / 1000) * 1000);
  check('a seconds timestamp is read as seconds', feed.epochMs(1_761_191_100) === 1_761_191_100_000);
  check('a millisecond timestamp is left alone', feed.epochMs(1_761_191_100_000) === 1_761_191_100_000);
  check('an unsupported segment (MCX) is ignored', feed.parsePacket(quotePacket({ exchangeType: 5, token: '9', at: t(0), last: 1 })) === null);
  check('exchange type 2 is NFO', feed.parsePacket(quotePacket({ exchangeType: 2, token: '43650', at: t(0), last: 120.5 }))?.exchange === 'NFO');
  const bfo = feed.parsePacket(quotePacket({ exchangeType: 4, token: '866735', at: t(0), last: 337.85, high: 470, low: 330, mode: 3, lastTraded: t(0) }));
  check('exchange type 4 is BFO, priced in paise like the rest', bfo?.exchange === 'BFO' && bfo?.lastPrice === 337.85 && bfo?.dayHigh === 470, bfo);
  const mixedPlan = feed.planConnections([
    { exchange: 'NSE', token: '2885' },
    { exchange: 'BFO', token: '866735' },
    { exchange: 'NFO', token: '43650' },
  ]);
  check('contracts subscribe under their own segments', JSON.stringify(mixedPlan) === JSON.stringify([[{ exchangeType: 1, tokens: ['2885'] }, { exchangeType: 4, tokens: ['866735'] }, { exchangeType: 2, tokens: ['43650'] }]]), mixedPlan);
  check('a short frame is ignored', feed.parsePacket(Buffer.alloc(20)) === null);

  const many = Array.from({ length: 2_500 }, (_, index) => ({ exchange: (index % 2 ? 'BSE' : 'NSE') as 'NSE' | 'BSE', token: String(index) }));
  const plans = feed.planConnections(many);
  const planned = plans.map((plan) => plan.reduce((sum, group) => sum + group.tokens.length, 0));
  check('2,500 instruments need three connections of at most 1,000', plans.length === 3 && planned.join() === '1000,1000,500', planned);
  check('each connection groups tokens by exchange type', plans[0]?.every((group) => group.exchangeType === 1 || group.exchangeType === 3) ?? false);
  let overLimit = false;
  try {
    feed.planConnections(Array.from({ length: 3_001 }, (_, index) => ({ exchange: 'NSE' as const, token: String(index) })));
  } catch {
    overLimit = true;
  }
  check('more than 3,000 instruments is refused, not silently truncated', overLimit);

  /* --------------------------------------------------- the 30-second range */
  console.log('\nstockbot — opening range');
  const instrument = (token: string, symbol: string) => ({ exchange: 'NSE' as const, token, symbol, name: symbol, isIndex: false });
  const target = (token: string, symbol: string, sources: string[]) => ({ instrument: instrument(token, symbol), sources: new Set(sources) });
  const packet = (
    token: string,
    at: number,
    last: number,
    high: number | null,
    low: number | null,
    lastTraded: number | null = null,
  ) => ({
    exchange: 'NSE' as const,
    token,
    exchangeTime: new Date(at),
    lastTradeTime: lastTraded === null ? null : new Date(lastTraded),
    lastPrice: last,
    open: high === null ? null : 100,
    dayHigh: high,
    dayLow: low,
  });

  const capture = new range.OpeningRangeCapture(times.rangeStart, times.rangeEnd, times.sessionStart);
  check('a packet a moment before 09:15:00 is not in the range', !capture.add(packet('A', t(-100), 150, 999, 1)));
  capture.add(packet('A', t(5_000), 100, 101, 99));
  capture.add(packet('A', t(29_500), 100.5, 102, 98.5));
  // Arrives later but was stamped earlier: must not replace the newer packet.
  capture.add(packet('A', t(1_000), 100, 100.5, 99.5));
  check('a packet stamped exactly 09:15:30 is outside the range', !capture.add(packet('A', t(30_000), 110, 110, 98.5)));
  capture.add(packet('B', t(-60_000), 50, 51, 49)); // pre-open only
  capture.add(packet('C', t(2_000), 50, null, null)); // no day figures
  capture.add(packet('C', t(3_000), 51, null, null));
  // A holiday: sent inside the window, but its last trade was the previous session.
  const yesterday = times.rangeStart.getTime() - 18 * 3_600_000;
  check('a snapshot whose last trade was yesterday is not in the range', !capture.add(packet('E', t(10_000), 70, 72, 68, yesterday)));
  check('one whose last trade was this morning is', capture.add(packet('F', t(10_000), 70, 72, 68, t(9_000))));
  check('the pre-open auction trade counts as this morning', capture.add(packet('G', t(10_000), 70, 72, 68, times.sessionStart.getTime() + 8 * 60_000)));
  check('instruments with a packet in the window', capture.instrumentsSeen === 4, capture.instrumentsSeen);

  const levels = capture.freeze([
    target('A', 'AAA-EQ', ['holdings', 'watchlist:One']),
    target('B', 'BBB-EQ', ['watchlist:One']),
    target('C', 'CCC-EQ', ['holdings']),
    target('D', 'DDD-EQ', ['holdings']),
    target('E', 'EEE-EQ', ['holdings']),
  ]);
  const levelOf = (token: string) => levels.find((level) => level.token === token);
  check('a holiday snapshot leaves the stock without a range', levelOf('E')?.status === 'no_data');
  check('the range is the day high/low on the last packet in the window', levelOf('A')?.high === 102 && levelOf('A')?.low === 98.5, levelOf('A'));
  check('the 09:15:30 packet did not widen it', levelOf('A')?.high !== 110);
  check('the range carries the packet it came from', levelOf('A')?.packetAt?.getTime() === t(29_500));
  check('sources are kept, sorted', levelOf('A')?.sources.join() === 'holdings,watchlist:One');
  check('a stock seen only before 09:15 has no range', levelOf('B')?.status === 'no_data' && levelOf('B')?.high === null);
  check('without day figures, the last prices make the range', levelOf('C')?.high === 51 && levelOf('C')?.low === 50, levelOf('C'));
  check('a stock never heard from has no range', levelOf('D')?.status === 'no_data');

  /* ------------------------------------------------------------ breakouts */
  console.log('\nstockbot — breakouts');
  const detector = new range.BreakoutDetector(levels, times.rangeEnd);
  check('only stocks with a range are watched', detector.watching === 2, detector.watching);
  check('a packet stamped inside the window never breaks it', detector.check(packet('A', t(29_900), 500, 500, 1)).length === 0);
  check('touching the high is not a break', detector.check(packet('A', t(40_000), 102, 102, 98.5)).length === 0);
  const up = detector.check(packet('A', t(41_000), 101.9, 102.05, 98.5));
  check('one paisa above the high is a break up', up.length === 1 && up[0]?.direction === 'up', up);
  check('the break reports the day high that crossed, and the last price', up[0]?.price === 102.05 && up[0]?.lastPrice === 101.9 && up[0]?.level === 102, up[0]);
  check('the same level never fires twice', detector.check(packet('A', t(50_000), 105, 105, 98.5)).length === 0);
  const down = detector.check(packet('A', t(60_000), 98.6, 105, 98.4));
  check('the low breaks independently of the high', down.length === 1 && down[0]?.direction === 'down' && down[0]?.price === 98.4, down);
  check('an unwatched stock is ignored', detector.check(packet('D', t(60_000), 1, 999, 0.5)).length === 0);
  const both = new range.BreakoutDetector(levels, times.rangeEnd).check(packet('C', t(70_000), 50.5, 52, 49));
  check('one packet can break both sides (a gap through the range)', both.length === 2, both);
  const resumed = new range.BreakoutDetector(levels, times.rangeEnd, [range.breakoutKey('NSE', 'A', 'up')]);
  check('after a restart, a break already recorded is not fired again', resumed.check(packet('A', t(80_000), 110, 110, 98.5)).length === 0);

  /* --------------------------------------------------------------- targets */
  console.log('\nstockbot — target list');
  const row = (exch_seg: string, token: string, symbol: string, name: string, instrumenttype = '') => ({ exch_seg, token, symbol, name, instrumenttype });
  const index = new InstrumentIndex([
    row('NSE', '2885', 'RELIANCE-EQ', 'RELIANCE'),
    row('BSE', '500325', 'RELIANCE', 'RELIANCE'),
    row('NSE', '3045', 'SBIN-EQ', 'SBIN'),
    row('BSE', '500112', 'SBIN', 'SBIN'),
    row('NSE', '11536', 'TCS-EQ', 'TCS'),
    row('NSE', '777', 'SMEXYZ-SM', 'SMEXYZ'),
    row('BSE', '999', 'BSEONLY', 'BSEONLY'),
    row('NSE', '99926000', 'Nifty 50', 'NIFTY', 'AMXIDX'),
    row('NFO', '35000', 'NIFTY26OCTFUT', 'NIFTY', 'FUTIDX'),
  ]);
  check('only the cash segments are indexed', index.size === 8, index.size);
  check('a bare NSE symbol finds the EQ series', index.resolve('NSE', 'reliance')?.token === '2885');
  check('then the other equity series', index.resolve('NSE', 'SMEXYZ')?.token === '777');
  check('an index resolves by name', index.resolve('NSE', 'NIFTY')?.token === '99926000');

  const built = targetsModule.buildTargetList(
    [
      { exchange: 'NSE', symboltoken: '2885', tradingsymbol: 'RELIANCE-EQ' },
      { exchange: 'BSE', symboltoken: 500112, tradingsymbol: 'SBIN' },
      { exchange: 'BSE', symboltoken: '999', tradingsymbol: 'BSEONLY' },
      { exchange: 'NSE', symboltoken: '424242', tradingsymbol: 'NEWLIST-EQ' },
      { exchange: 'MCX', symboltoken: '1', tradingsymbol: 'GOLD' },
    ],
    { A: ['RELIANCE', 'TCS', 'NIFTY'], B: ['NSE:SBIN', 'BSE:RELIANCE', 'NOPE', 'MCX:GOLD'] },
    index,
    'NSE',
  );
  const sourcesOf = (key: string) => [...(built.targets.get(key)?.sources ?? [])].sort().join();
  check('seven unique instruments', built.targets.size === 7, [...built.targets.keys()]);
  check('a stock in holdings and a watchlist is tracked once', sourcesOf('NSE:2885') === 'holdings,watchlist:A');
  check('a BSE holding moves to its NSE listing', sourcesOf('NSE:3045') === 'holdings,watchlist:B' && !built.targets.has('BSE:500112'));
  check('a BSE-only holding stays on BSE', sourcesOf('BSE:999') === 'holdings');
  check('an explicit BSE: entry is kept on BSE', sourcesOf('BSE:500325') === 'watchlist:B');
  check('a holding missing from the master keeps its own token', built.targets.get('NSE:424242')?.instrument.symbol === 'NEWLIST-EQ');
  check(
    'unresolved entries are reported, not dropped silently',
    built.unresolved.length === 3 && built.unresolved.some((entry) => entry.startsWith('B: NOPE')) && built.unresolved.some((entry) => entry.includes('MCX')),
    built.unresolved,
  );

  console.log('\nstockbot — F&O stocks from the instrument master');
  const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const expiryIn = (days: number) => {
    const date = new Date(Date.now() + days * 86_400_000);
    return `${String(date.getUTCDate()).padStart(2, '0')}${MONTH_NAMES[date.getUTCMonth()]}${date.getUTCFullYear()}`;
  };
  const future = (token: string, name: string, expiry: string, type = 'FUTSTK') => ({
    ...row('NFO', token, `${name}FUT`, name, type),
    expiry,
  });
  const fnoIndex = new InstrumentIndex([
    row('NSE', '2885', 'RELIANCE-EQ', 'RELIANCE'),
    row('NSE', '11536', 'TCS-EQ', 'TCS'),
    row('NSE', '9001', '011NSETEST-EQ', '011NSETEST'),
    row('NSE', '9002', 'OLDFUT-EQ', 'OLDFUT'),
    future('1', 'RELIANCE', expiryIn(20)),
    future('2', 'RELIANCE', expiryIn(50)), // next month: same stock, counted once
    future('3', 'TCS', expiryIn(20)),
    future('4', '011NSETEST', '27NOV2036'), // the exchange's test instrument
    future('5', 'OLDFUT', '27JAN2000'), // expired
    future('6', 'RELIANCE', expiryIn(20), 'OPTSTK'), // options do not define the list
    future('7', 'NIFTY', expiryIn(20), 'FUTIDX'), // nor do index futures
    future('8', 'GHOST', expiryIn(20)), // no NSE cash listing
  ]);
  const fnoList = fnoIndex.fnoStocks();
  check('F&O stocks are the underlyings of current stock futures, once each', fnoList.instruments.map((item) => item.symbol).join() === 'RELIANCE-EQ,TCS-EQ', fnoList.instruments);
  check("the exchange's test instruments and expired contracts are left out", !fnoList.instruments.some((item) => /NSETEST|OLDFUT/.test(item.symbol)));
  check('an underlying with no cash listing is reported', fnoList.unresolved.join() === 'GHOST', fnoList.unresolved);
  check('futures rows do not enter the cash index', fnoIndex.size === 4, fnoIndex.size);
  const withFno = targetsModule.buildTargetList([{ exchange: 'NSE', symboltoken: '2885', tradingsymbol: 'RELIANCE-EQ' }], {}, fnoIndex, 'NSE');
  check('F&O stocks join the target list with no watchlist at all', withFno.targets.size === 2, [...withFno.targets.keys()]);
  check('a held F&O stock is tracked once, with both reasons', [...(withFno.targets.get('NSE:2885')?.sources ?? [])].sort().join() === 'fno,holdings');
  check('the unlisted underlying is reported, not dropped', withFno.unresolved.some((entry) => entry.startsWith('F&O: GHOST')), withFno.unresolved);

  console.log('\nstockbot — option and future contracts in a watchlist');
  const contractIndex = new InstrumentIndex([
    row('NSE', '2885', 'RELIANCE-EQ', 'RELIANCE'),
    { ...row('BFO', '866735', 'SENSEX26OCT73800CE', 'SENSEX', 'OPTIDX'), expiry: expiryIn(5) },
    { ...row('BFO', '863334', 'SENSEX26OCT73200PE', 'SENSEX', 'OPTIDX'), expiry: expiryIn(5) },
    { ...row('NFO', '43650', 'NIFTY27OCT2622700CE', 'NIFTY', 'OPTIDX'), expiry: expiryIn(3) },
  ]);
  check('a BSE option resolves by its exact trading symbol', contractIndex.resolve('BFO', 'sensex26oct73800ce')?.token === '866735');
  check('an NSE option too', contractIndex.resolve('NFO', 'NIFTY27OCT2622700CE')?.token === '43650');
  check('a contract that is not listed (expired) does not resolve', contractIndex.resolve('BFO', 'SENSEX26SEP73800CE') === null);
  check('a contract is not found under the cash segment', contractIndex.resolve('BSE', 'SENSEX26OCT73800CE') === null);
  check('contracts do not count as cash instruments', contractIndex.size === 1);
  const withContracts = targetsModule.buildTargetList(
    [],
    { 'Watchlist 4': ['BFO:SENSEX26OCT73800CE', 'bfo:SENSEX26OCT73200PE', 'BFO:SENSEX26SEP73800CE'] },
    contractIndex,
    'NSE',
  );
  check('watchlist contracts become targets on their segment', withContracts.targets.has('BFO:866735') && withContracts.targets.has('BFO:863334'), [...withContracts.targets.keys()]);
  check('an expired contract is reported so the list can be refreshed', withContracts.unresolved.join() === 'Watchlist 4: BFO:SENSEX26SEP73800CE', withContracts.unresolved);

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'stockbot-e2e-'));
  try {
    const file = path.join(scratch, 'watchlists.json');
    check('no watchlists.json means holdings only', Object.keys(await targetsModule.readWatchlists(file)).length === 0);
    await fs.writeFile(file, JSON.stringify({ watchlists: { 'My List': ['RELIANCE', 'BSE:SBIN'] } }));
    const lists = await targetsModule.readWatchlists(file);
    check('a valid watchlists.json is read', lists['My List']?.join() === 'RELIANCE,BSE:SBIN', lists);
    await fs.writeFile(file, JSON.stringify({ watchlists: { A: 'RELIANCE' } }));
    const badShape = await targetsModule.readWatchlists(file).then(() => false, () => true);
    check('a list that is not an array is refused', badShape);
    await fs.writeFile(file, '{"watchlists": ');
    const badJson = await targetsModule.readWatchlists(file).then(() => false, () => true);
    check('invalid JSON is refused', badJson);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }

  check('the harness has no ANGEL_* credentials, so the bot reports "not configured"', (() => {
    const loaded = loadStockbotSettings();
    return !loaded.ok && !loaded.configured;
  })());

  /* ---------------------------------------------- repository: lease, claims */
  console.log('\nstockbot — day lease and claims');
  const day = '2000-01-03'; // far from any real session in this database
  const created = await repo.ensureDay(day);
  check('a day starts as "starting"', created.status === 'starting' && created.attempts === 0, created);
  check('ensureDay is idempotent', (await repo.ensureDay(day)).tradeDate === day);

  check('the first runner claims the day', await repo.claimDay(day, 'runner-a', 'e2e:a', 60));
  check('a second runner cannot while the lease is live', !(await repo.claimDay(day, 'runner-b', 'e2e:b', 60)));
  check('the holder renews', await repo.renewLease(day, 'runner-a', 60));
  check('a non-holder cannot renew', !(await repo.renewLease(day, 'runner-b', 60)));
  check('a non-holder cannot change the day', !(await repo.updateDay(day, 'runner-b', { status: 'monitoring' })));
  check('the holder can', await repo.updateDay(day, 'runner-a', { status: 'capturing', targetCount: 4 }));
  await repo.releaseLease(day, 'runner-a');
  check('after a release the next runner claims at once', await repo.claimDay(day, 'runner-b', 'e2e:b', 60));
  check('attempts count each claim', (await repo.findDay(day))?.attempts === 2);

  await ctx.utcDb.execute(
    "UPDATE stockbot_days SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE trade_date = ?",
    [day],
  );
  check('an expired lease can be taken over', await repo.claimDay(day, 'runner-c', 'e2e:c', 60));
  check('the old holder has lost it', !(await repo.renewLease(day, 'runner-b', 60)));

  check('the levels email is claimed once', await repo.claimDayEmail(day, 'levels'));
  check('and only once', !(await repo.claimDayEmail(day, 'levels')));
  check('the notice email is claimed separately', await repo.claimDayEmail(day, 'notice'));

  await repo.saveLevels(day, levels);
  const loaded = await repo.loadLevels(day);
  const savedA = loaded.find((level) => level.token === 'A');
  check('levels round-trip', loaded.length === levels.length && savedA?.high === 102 && savedA?.low === 98.5, savedA);
  check('the packet time round-trips to the millisecond', savedA?.packetAt?.getTime() === t(29_500), savedA?.packetAt);
  check('a no-data level round-trips with no prices', loaded.find((level) => level.token === 'D')?.high === null);
  await repo.saveLevels(day, levels.map((level) => (level.token === 'A' ? { ...level, high: 103 } : level)));
  const resaved = await repo.loadLevels(day);
  check('saving again updates rather than duplicates', resaved.length === levels.length && resaved.find((level) => level.token === 'A')?.high === 103);

  await repo.saveLevels(day, [
    { exchange: 'BFO', token: '866735', symbol: 'SENSEX26OCT73800CE', sources: ['watchlist:Watchlist 4'], status: 'ok', high: 470, low: 330.05, open: 400, packetAt: new Date(t(20_000)) },
  ]);
  const contractLevel = (await repo.loadLevels(day)).find((level) => level.token === '866735');
  check('a BFO contract level is stored and read back (migration 037)', contractLevel?.exchange === 'BFO' && contractLevel?.low === 330.05, contractLevel);
  check(
    'and a BFO break is recorded',
    await repo.insertBreakout(day, { exchange: 'BFO', token: '866735', symbol: 'SENSEX26OCT73800CE', direction: 'down', level: 330.05, price: 329.5, lastPrice: 331, detectedAt: new Date(t(90_000)) }),
  );
  // Settle it so the alert-claim checks below see only the stock break.
  await repo.claimAlerts(day, 'claim-bfo');
  await repo.settleAlerts('claim-bfo');

  const event = { ...(up[0] ?? { exchange: 'NSE' as const, token: 'A', symbol: 'AAA-EQ', direction: 'up' as const, level: 102, price: 102.05, lastPrice: 101.9, detectedAt: new Date(t(41_000)) }), symbol: 'AAA-EQ' };
  check('a break is recorded once', await repo.insertBreakout(day, event));
  check('recording it again inserts nothing', !(await repo.insertBreakout(day, event)));
  check('a restarted session knows it fired', (await repo.firedBreakoutKeys(day)).includes(range.breakoutKey('NSE', 'A', 'up')));

  const first = await repo.claimAlerts(day, 'claim-1');
  check('the alert flush takes the new break', first.length === 1 && first[0]?.price === 102.05, first);
  check('a concurrent flush gets nothing', (await repo.claimAlerts(day, 'claim-2')).length === 0);
  await repo.releaseAlerts('claim-1');
  const retried = await repo.claimAlerts(day, 'claim-3');
  check('a failed send hands the break back for the next flush', retried.length === 1);
  await repo.settleAlerts('claim-3');
  await repo.releaseAbandonedAlerts(day);
  check('a settled alert is never re-sent', (await repo.claimAlerts(day, 'claim-4')).length === 0);
  check('the break shows as alerted', (await repo.listBreakouts(day))[0]?.alertedAt instanceof Date);

  await repo.updateDay(day, 'runner-c', { status: 'closed', finished: true });
  check('a closed day cannot be claimed again', !(await repo.claimDay(day, 'runner-d', 'e2e:d', 60)));

  /* ---------------------------------------------------------------- emails */
  console.log('\nstockbot — emails');
  const levelsMail = email.stockbotLevelsEmail({
    tradeDate: day,
    levels: [{ symbol: 'AAA-EQ', exchange: 'NSE', high: 102, low: 98.5, sources: ['holdings'] }],
    missing: [{ symbol: 'DDD-EQ', exchange: 'NSE' }],
    unresolved: ['B: NOPE'],
  });
  check('the levels subject gives the count', levelsMail.subject.startsWith('Opening range set for 1 stock '), levelsMail.subject);
  check('the series suffix is dropped for reading', levelsMail.text.includes('AAA') && !levelsMail.text.includes('AAA-EQ'));
  check('stocks without a range are named', levelsMail.text.includes('DDD'));
  const breakMail = email.stockbotBreakoutsEmail({
    tradeDate: day,
    breakouts: Array.from({ length: 5 }, (_, n) => ({
      symbol: `S${n}-EQ`,
      exchange: 'NSE',
      direction: n % 2 ? ('down' as const) : ('up' as const),
      level: 1000 + n,
      price: 1001 + n,
      lastPrice: 1000.5 + n,
      detectedAt: new Date(t(60_000)),
    })),
  });
  check('a breakout subject names the first three and counts the rest', breakMail.subject === 'Breakout: S0 above 1,000.00, S1 below 1,001.00, S2 above 1,002.00 +2 more', breakMail.subject);
  check('prices use Indian grouping with paise', email.formatPrice(123456.5) === '1,23,456.50');
  check('a short levels email has no attachment', levelsMail.attachments.length === 0);

  const manyLevels = Array.from({ length: 213 }, (_, n) => ({
    symbol: `S${String(n).padStart(3, '0')}-EQ`,
    exchange: 'NSE',
    high: 100 + n,
    low: 99 + n,
    sources: n === 0 ? ['fno', 'watchlist:Mine, too'] : ['fno'],
  }));
  const bigMail = email.stockbotLevelsEmail({ tradeDate: day, levels: manyLevels, missing: [], unresolved: [] });
  const csvText = bigMail.attachments[0]?.content.toString('utf8') ?? '';
  check('a 213-stock levels email stays under Gmail\'s clipping size', Buffer.byteLength(bigMail.html) < 100_000, Buffer.byteLength(bigMail.html));
  check('its table says how many are shown and where the rest are', bigMail.html.includes('Showing 60 of 213'));
  check('the full list is attached as levels.csv', bigMail.attachments[0]?.filename === 'levels.csv' && csvText.trim().split('\r\n').length === 214);
  check('CSV fields with commas are quoted', csvText.includes('"F&O, Mine, too"'), csvText.split('\r\n')[1]);
  check('the plain-text part keeps every row', bigMail.text.includes('S212'));

  await tradingDays(ctx, levels);
  await statusPage(ctx);
}

/** The trader's read-only page, over HTTP, against the days the scenarios above recorded. */
async function statusPage(ctx: E2EContext) {
  const { check } = ctx;
  const repo = await import('../../src/modules/stockbot/stockbot.repository');
  const client = ctx.makeClient(ctx.base);
  const token = 'e2e-stockbot-view-0123456789abcdef';
  const page = async (query = '') => {
    const response = await client.getRaw(`/stockbot/${token}${query}`);
    return { ...response, html: response.body.toString('utf8') };
  };

  console.log('\nstockbot — the status page');
  check('a wrong token is a plain 404', (await client.getRaw('/stockbot/not-the-token-0123456789abcdef')).status === 404);
  check('so is no token at all', (await client.getRaw('/stockbot/')).status === 404);

  const closed = await page('?date=2000-01-04');
  check('the right token gets the page', closed.status === 200 && (closed.headers.get('content-type') ?? '').startsWith('text/html'), closed.status);
  check('it says how the day went', closed.html.includes('Closed for the day'));
  check('it lists the break', closed.html.includes('Above high') && closed.html.includes('102.00'));
  check('symbols read without the series suffix', closed.html.includes('AAA') && !closed.html.includes('AAA-EQ'));
  check('a stock with no range says so', closed.html.includes('No trade in the window'));
  const csp = closed.headers.get('content-security-policy') ?? '';
  check('its CSP allows its own stylesheet by hash and no script', /style-src 'sha256-[A-Za-z0-9+/=]+'/.test(csp) && !csp.includes('unsafe') && !csp.includes('script-src'), csp);
  check('it is never cached and never leaks the link as a referrer', closed.headers.get('cache-control') === 'no-store' && closed.headers.get('referrer-policy') === 'no-referrer');
  check('a past day does not reload itself', !closed.html.includes('http-equiv="refresh"'));

  const holiday = await page('?date=2000-01-05');
  check('a holiday reads as no market data', holiday.html.includes('No market data'));
  const refused = await page('?date=2000-01-06');
  check('a refused login reads as did not run, with the reason', refused.html.includes('Did not run') && refused.html.includes('Login refused'));

  const searched = await page('?date=2000-01-04&q=bbb');
  check('search narrows the lists, case-insensitively', searched.html.includes('BBB') && !searched.html.includes('Above high') && searched.html.includes('No breakouts match.'));
  const wildcard = await page('?date=2000-01-04&q=%25');
  check('a LIKE wildcard in the search is ignored, not obeyed', wildcard.status === 200 && wildcard.html.includes('Above high'));
  const badDate = await page('?date=2000-02-30');
  check('an impossible date falls back to today rather than failing', badDate.status === 200);

  // A big day, to page through.
  const bigDay = '2000-01-18';
  await repo.ensureDay(bigDay);
  await repo.saveLevels(
    bigDay,
    Array.from({ length: 120 }, (_, n) => ({
      exchange: 'NSE' as const,
      token: `T${n}`,
      symbol: n === 7 ? '<b>X</b>-EQ' : `S${String(n).padStart(3, '0')}-EQ`,
      sources: ['fno'],
      status: 'ok' as const,
      high: 100 + n,
      low: 99 + n,
      open: 100,
      packetAt: new Date(),
    })),
  );
  const first = await page(`?date=${bigDay}`);
  check('a long list is paged on the server, 50 rows at a time', first.html.includes('Page 1 of 3') && (first.html.match(/<tr>/g) ?? []).length === 51, (first.html.match(/<tr>/g) ?? []).length);
  check('names from the data are escaped', first.html.includes('&lt;b&gt;X&lt;/b&gt;') && !first.html.includes('<b>X</b>'));
  const third = await page(`?date=${bigDay}&lp=3`);
  check('the last page has the rest', third.html.includes('Page 3 of 3') && third.html.includes('S119'));
  const beyond = await page(`?date=${bigDay}&lp=999`);
  check('a page past the end shows the last page', beyond.html.includes('Page 3 of 3') && beyond.html.includes('S119'));
  check('day links step between recorded days', first.html.includes('?date=2000-01-17'), first.html.match(/href="\?date=[^"]+"/g));
}

/**
 * Whole trading days through the real session code, in seconds: the market clock is
 * compressed, Angel is replaced by a scripted feed and a stub login, and the mailer
 * records subjects. The database is the real scratch one.
 */
async function tradingDays(ctx: E2EContext, sampleLevels: import('../../src/modules/stockbot/stockbot.schema').FrozenLevel[]) {
  const { check } = ctx;
  const service = await import('../../src/modules/stockbot/stockbot.service');
  const repo = await import('../../src/modules/stockbot/stockbot.repository');
  const { InstrumentIndex } = await import('../../src/modules/stockbot/instruments');
  const { AngelRefusedError } = await import('../../src/modules/stockbot/smartapi.client');
  type Schema = typeof import('../../src/modules/stockbot/stockbot.schema');
  type QuotePacket = import('../../src/modules/stockbot/stockbot.schema').QuotePacket;

  const settings = {
    clientCode: 'A12345678',
    pin: '1234',
    totpSecret: Buffer.from('not used'),
    apiKey: 'test-key',
    staticIps: [],
    preferredExchange: 'NSE' as const,
    emailsEnabled: true,
    dataDirectory: os.tmpdir(),
    watchlistFile: 'unused',
    cacheDirectory: 'unused',
  };
  const index = new InstrumentIndex([
    { exch_seg: 'NSE', token: 'A', symbol: 'AAA-EQ', name: 'AAA', instrumenttype: '' },
    { exch_seg: 'NSE', token: 'B', symbol: 'BBB-EQ', name: 'BBB', instrumenttype: '' },
  ]);

  /** A market day squeezed into ~3 s, positioned relative to now. */
  const compressed = (shiftMs = 0): ReturnType<Schema['marketTimes']> => {
    const base = Date.now() + shiftMs;
    const rangeStart = new Date(base + 400);
    const rangeEnd = new Date(base + 1_400);
    return {
      sessionStart: new Date(base - 60_000),
      rangeStart,
      rangeEnd,
      freezeAt: new Date(rangeEnd.getTime() + 300),
      close: new Date(base + 3_000),
    };
  };

  /** A packet, or the socket refusing our session (which asks for a fresh login). */
  type Step = { at: number; packet?: () => QuotePacket; authRejected?: true };
  const quote = (token: string, high: number, low: number, lastTraded: number | null = Date.now()): QuotePacket => ({
    exchange: 'NSE',
    token,
    exchangeTime: new Date(),
    lastTradeTime: lastTraded === null ? null : new Date(lastTraded),
    lastPrice: (high + low) / 2,
    open: 100,
    dayHigh: high,
    dayLow: low,
  });

  async function runDay(options: {
    tradeDate: string;
    times: ReturnType<Schema['marketTimes']>;
    script?: (times: ReturnType<Schema['marketTimes']>) => Step[];
    login?: () => Promise<import('../../src/modules/stockbot/smartapi.client').AngelSession>;
    loadInstruments?: () => Promise<never>;
    abortAt?: number;
    /** STOCKBOT_EMAILS; on unless a scenario says otherwise. */
    emails?: boolean;
  }) {
    const sent: string[] = [];
    let logins = 0;
    let logouts = 0;
    let feedStopped = false;
    const timers: NodeJS.Timeout[] = [];
    const controller = new AbortController();
    if (options.abortAt) timers.push(setTimeout(() => controller.abort(), options.abortAt - Date.now()));

    const outcome = await service.runTradingSession({ ...settings, emailsEnabled: options.emails ?? true }, controller.signal, {
      tradeDate: () => options.tradeDate,
      times: () => options.times,
      login:
        options.login ??
        (async () => {
          logins += 1;
          return {
            clientCode: settings.clientCode,
            apiKey: settings.apiKey,
            jwtToken: 'jwt',
            refreshToken: 'refresh',
            feedToken: 'feed',
            publicIp: null,
            ordersAllowed: null,
            loggedInAt: new Date(),
            headers: {},
          };
        }),
      logout: async () => {
        logouts += 1;
      },
      fetchHoldings: async () => [{ exchange: 'NSE', symboltoken: 'A', tradingsymbol: 'AAA-EQ' }],
      loadInstruments: options.loadInstruments ?? (async () => index),
      readWatchlists: async () => ({ W: ['BBB'] }),
      createFeed: (feedOptions) => ({
        start() {
          for (const step of options.script?.(options.times) ?? []) {
            const fire = () => {
              if (step.packet) feedOptions.onPacket(step.packet());
              if (step.authRejected) void feedOptions.onAuthRejected?.().catch(() => undefined);
            };
            timers.push(setTimeout(fire, Math.max(step.at - Date.now(), 0)));
          }
        },
        stop() {
          feedStopped = true;
        },
        stats: () => ({ connected: 1, packets: 0, reconnects: 0 }),
      }),
      notify: async (input) => {
        sent.push(input.subject);
        return 'sent';
      },
    });
    for (const timer of timers) clearTimeout(timer);
    return { outcome, sent, logins, logouts, feedStopped };
  }

  /* -------------------------------------------------------- a normal day */
  console.log('\nstockbot — a whole trading day, compressed');
  const normalDate = '2000-01-04';
  const normal = await runDay({
    tradeDate: normalDate,
    times: compressed(),
    script: (times) => [
      { at: times.rangeStart.getTime() + 100, packet: () => quote('A', 101, 99) },
      { at: times.rangeStart.getTime() + 600, packet: () => quote('A', 102, 98.5) },
      { at: times.freezeAt.getTime() + 300, packet: () => quote('A', 102.5, 98.5) },
      { at: times.freezeAt.getTime() + 500, packet: () => quote('A', 103, 98.5) },
    ],
  });
  check('the day runs to the close', normal.outcome.kind === 'ran' && 'status' in normal.outcome && normal.outcome.status === 'closed', normal.outcome);
  const normalDay = await repo.findDay(normalDate);
  check('the day row records the levels', normalDay?.status === 'closed' && normalDay?.levelsOk === 1 && normalDay?.levelsMissing === 1, normalDay);
  check('the lease is released at the end', normalDay?.leaseExpiresAt === null);
  const normalLevels = await repo.loadLevels(normalDate);
  check('the traded stock got its range', normalLevels.find((level) => level.token === 'A')?.high === 102);
  check('the silent watchlist stock is saved as no_data', normalLevels.find((level) => level.token === 'B')?.status === 'no_data');
  const normalBreaks = await repo.listBreakouts(normalDate);
  check('one break up, reported once', normalBreaks.length === 1 && normalBreaks[0]?.direction === 'up' && normalBreaks[0]?.price === 102.5, normalBreaks);
  check('and alerted', normalBreaks[0]?.alertedAt instanceof Date);
  check('the levels email went out', normal.sent.some((subject) => subject.startsWith('Opening range set for 1 stock')), normal.sent);
  check('the breakout email went out', normal.sent.some((subject) => subject.startsWith('Breakout: AAA above 102.00')), normal.sent);
  check('exactly those two emails', normal.sent.length === 2, normal.sent);
  check('logged in once and out once; the feed was stopped', normal.logins === 1 && normal.logouts === 1 && normal.feedStopped);

  const again = await runDay({ tradeDate: normalDate, times: compressed() });
  check('a finished day is not run again', again.outcome.kind === 'final' && again.logins === 0, again.outcome);

  console.log('\nstockbot — the same day with emails off (STOCKBOT_EMAILS unset)');
  const quietDate = '2000-01-17';
  const quiet = await runDay({
    tradeDate: quietDate,
    times: compressed(),
    emails: false,
    script: (times) => [
      { at: times.rangeStart.getTime() + 100, packet: () => quote('A', 101, 99) },
      { at: times.freezeAt.getTime() + 300, packet: () => quote('A', 101.5, 99) },
    ],
  });
  check('the day still runs to the close', quiet.outcome.kind === 'ran' && 'status' in quiet.outcome && quiet.outcome.status === 'closed', quiet.outcome);
  check('no email of any kind is sent', quiet.sent.length === 0, quiet.sent);
  check('the levels are still saved', (await repo.loadLevels(quietDate)).find((level) => level.token === 'A')?.high === 101);
  const quietBreaks = await repo.listBreakouts(quietDate);
  check('the break is still recorded, and settled rather than left pending', quietBreaks.length === 1 && quietBreaks[0]?.alertedAt instanceof Date, quietBreaks);

  /* -------------------------------------------------------------- holiday */
  console.log('\nstockbot — a holiday');
  const holiday = await runDay({
    tradeDate: '2000-01-05',
    times: compressed(),
    script: (times) => [
      // Sent inside the window, but carrying the previous session's trade.
      { at: times.rangeStart.getTime() + 200, packet: () => quote('A', 120, 90, Date.now() - 86_400_000) },
      { at: times.rangeStart.getTime() + 300, packet: () => quote('B', 60, 50, Date.now() - 86_400_000) },
    ],
  });
  check('a holiday ends as no_data', holiday.outcome.kind === 'ran' && 'status' in holiday.outcome && holiday.outcome.status === 'no_data', holiday.outcome);
  check('with one notice and no levels email', holiday.sent.length === 1 && (holiday.sent[0] ?? '').includes('no market data'), holiday.sent);

  /* ------------------------------------------------------- refused login */
  console.log('\nstockbot — a refused login');
  const refused = await runDay({
    tradeDate: '2000-01-06',
    times: compressed(),
    login: async () => {
      throw new AngelRefusedError('login', 'AB1000', 'Invalid Password');
    },
  });
  check('a refused login fails the day without retrying', refused.outcome.kind === 'ran' && 'status' in refused.outcome && refused.outcome.status === 'failed', refused.outcome);
  check('one notice says why', refused.sent.length === 1 && (refused.sent[0] ?? '').includes('refused the login'), refused.sent);
  check('the day is final, so the scheduler will not log in again', (await repo.findDay('2000-01-06'))?.status === 'failed');

  /* ------------------------------------------- restart after the freeze */
  console.log('\nstockbot — restart after the freeze');
  const resumeDate = '2000-01-07';
  await repo.ensureDay(resumeDate);
  await repo.saveLevels(resumeDate, sampleLevels.filter((level) => level.token === 'A'));
  const resumeTimes = compressed(-2_000); // the levels froze 300 ms ago; close in 1 s
  const resumed = await runDay({
    tradeDate: resumeDate,
    times: resumeTimes,
    // Two packets: one may arrive before the detector is attached, and the feed's day
    // low is cumulative, so the second still carries the break — as in production.
    script: () => [
      { at: Date.now() + 150, packet: () => quote('A', 102, 98) },
      { at: Date.now() + 500, packet: () => quote('A', 102, 98) },
    ],
  });
  check('a restarted session resumes and runs to the close', resumed.outcome.kind === 'ran' && 'status' in resumed.outcome && resumed.outcome.status === 'closed', resumed.outcome);
  const resumedBreaks = await repo.listBreakouts(resumeDate);
  check('it catches a break with the saved levels', resumedBreaks.length === 1 && resumedBreaks[0]?.direction === 'down', resumedBreaks);
  check('and does not resend a levels email', !resumed.sent.some((subject) => subject.startsWith('Opening range')), resumed.sent);

  const late = await runDay({ tradeDate: '2000-01-10', times: compressed(-2_500) });
  check('a start after the window with nothing saved is "missed"', late.outcome.kind === 'ran' && 'status' in late.outcome && late.outcome.status === 'missed', late.outcome);
  check('without logging in', late.logins === 0);
  check('with one notice', late.sent.length === 1 && (late.sent[0] ?? '').includes('no breakout alerts today'), late.sent);

  /* --------------------------------------- busy, interrupted, retry */
  console.log('\nstockbot — another process, a shutdown, a retry');
  await repo.ensureDay('2000-01-11');
  await repo.claimDay('2000-01-11', 'someone-else', 'e2e:other', 60);
  const busy = await runDay({ tradeDate: '2000-01-11', times: compressed() });
  check('a day another live process holds is left alone', busy.outcome.kind === 'busy' && busy.logins === 0, busy.outcome);

  const stopTimes = compressed();
  const stopped = await runDay({ tradeDate: '2000-01-12', times: stopTimes, abortAt: stopTimes.rangeStart.getTime() + 200 });
  check('a shutdown mid-capture is "interrupted", not a failure', stopped.outcome.kind === 'interrupted', stopped.outcome);
  const stoppedDay = await repo.findDay('2000-01-12');
  check('the day stays open for the next process', stoppedDay?.status === 'capturing' && stoppedDay?.leaseExpiresAt === null, stoppedDay);
  check('and it logged out on the way', stopped.logouts === 1 && stopped.feedStopped);

  const retry = await runDay({
    tradeDate: '2000-01-13',
    times: compressed(),
    loadInstruments: async () => {
      throw new Error('instrument master download failed: HTTP 503');
    },
  });
  check('a transient failure asks for a retry', retry.outcome.kind === 'retry', retry.outcome);
  const retryDay = await repo.findDay('2000-01-13');
  check('with the reason recorded and the day still open', retryDay?.status === 'starting' && (retryDay?.lastError ?? '').includes('503'), retryDay);

  /* -------------------------------------------- a refused login mid-day */
  console.log('\nstockbot — the feed rejects the session and the new login is refused');
  let reloginAttempts = 0;
  const midDayTimes = compressed();
  const midDay = await runDay({
    tradeDate: '2000-01-14',
    times: midDayTimes,
    login: async () => {
      reloginAttempts += 1;
      if (reloginAttempts > 1) throw new AngelRefusedError('login', 'AB1000', 'Invalid Password');
      // Logged in long enough ago that a re-login is allowed.
      return {
        clientCode: settings.clientCode,
        apiKey: settings.apiKey,
        jwtToken: 'jwt',
        refreshToken: 'refresh',
        feedToken: 'feed',
        publicIp: null,
        ordersAllowed: null,
        loggedInAt: new Date(Date.now() - 10 * 60_000),
        headers: {},
      };
    },
    script: (times) => [
      { at: times.rangeStart.getTime() + 100, packet: () => quote('A', 101, 99) },
      { at: times.freezeAt.getTime() + 200, authRejected: true },
      { at: times.freezeAt.getTime() + 400, authRejected: true },
    ],
  });
  check('a refused re-login ends the day as failed', midDay.outcome.kind === 'ran' && 'status' in midDay.outcome && midDay.outcome.status === 'failed', midDay.outcome);
  check('after exactly one more attempt, never a second', reloginAttempts === 2, reloginAttempts);
  check('and the notice says so', midDay.sent.some((subject) => subject.includes('refused the login')), midDay.sent);
}
