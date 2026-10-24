import WebSocket from 'ws';
import { logger } from '../../utils/logger';
import { EXCHANGE_BY_TYPE, EXCHANGE_TYPE, type Exchange, type QuotePacket } from './stockbot.schema';

/**
 * SmartStream: Angel's binary market-data WebSocket.
 *
 * SNAP_QUOTE mode, for two of its fields. The exchange's cumulative day high and low: the
 * stream is a series of snapshots, not every trade, so the highest last-price we happen
 * to receive can miss a spike; the day high cannot. That is what makes both the 30-second
 * range and the breakout check exact, and why a reconnect loses nothing that matters —
 * the first packet afterwards still carries every trade made while we were away. And the
 * last-traded time: the packet's own timestamp is when the feed sent it, not when anything
 * traded (measured on a Saturday: packets stamped 06:55 that morning, carrying Friday's
 * high and low), so only the last-traded time can tell a holiday's stale snapshot from
 * this morning's trading.
 *
 * Angel's limits (from their forum; not in the API docs): 1,000 tokens per connection and
 * three connections per client, so up to 3,000 instruments.
 *
 * Unlike Angel's Python SDK, TLS certificates ARE verified (it passes CERT_NONE), and
 * nothing here can throw out of an event handler: the API process exits on an uncaught
 * exception, and the website must not go down because a market-data socket did.
 */

const FEED_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const MODE_QUOTE = 2;
const MODE_SNAP_QUOTE = 3;

export const MAX_TOKENS_PER_CONNECTION = 1_000;
export const MAX_CONNECTIONS = 3;

/** Angel asks for a text "ping" at least every 30 seconds and answers "pong". */
const HEARTBEAT_MS = 25_000;
/** No packet and no pong for this long means a dead socket nobody closed. */
const SILENCE_LIMIT_MS = 70_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Packet decoding                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Layout, little-endian (from Angel's SmartWebSocketV2 reference implementation):
 *
 *   0   u8    subscription mode (1 LTP, 2 QUOTE, 3 SNAP_QUOTE)
 *   1   u8    exchange type (1 nse_cm, 3 bse_cm)
 *   2   25B   token, NUL-terminated ASCII
 *   27  i64   sequence number
 *   35  i64   exchange timestamp
 *   43  i64   last traded price (paise)
 *   -- QUOTE and SNAP_QUOTE only --
 *   51  i64   last traded quantity      91  i64  open
 *   59  i64   average traded price      99  i64  day high
 *   67  i64   volume                    107 i64  day low
 *   75  f64   total buy quantity        115 i64  previous close
 *   83  f64   total sell quantity       (123 bytes for QUOTE)
 *   -- SNAP_QUOTE only --
 *   123 i64   last traded timestamp     (then OI, best five, circuit limits: 379 bytes)
 */
const LTP_PACKET_BYTES = 51;
const QUOTE_PACKET_BYTES = 123;
const SNAP_QUOTE_MIN_BYTES = 131;

/**
 * Epoch milliseconds from the exchange timestamp. Angel documents milliseconds; a value
 * small enough to be seconds is scaled rather than read as a date in January 1970, which
 * would silently put every packet before the window.
 */
export function epochMs(value: number): number {
  return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
}

function readInt64(buffer: Buffer, offset: number): number {
  return Number(buffer.readBigInt64LE(offset));
}

/** Decodes one binary packet, or null for anything that is not a cash-market quote. */
export function parsePacket(buffer: Buffer): QuotePacket | null {
  if (buffer.length < LTP_PACKET_BYTES) return null;

  const mode = buffer.readUInt8(0);
  const exchange = EXCHANGE_BY_TYPE.get(buffer.readUInt8(1));
  if (!exchange) return null;

  const nul = buffer.indexOf(0, 2);
  const token = buffer.toString('ascii', 2, nul === -1 || nul > 27 ? 27 : nul);
  if (!token) return null;

  const hasQuote = (mode === MODE_QUOTE || mode === MODE_SNAP_QUOTE) && buffer.length >= QUOTE_PACKET_BYTES;
  // Cash-market prices are paise. A zero means "no trade yet today", not a price.
  const rupees = (offset: number): number | null => {
    const value = readInt64(buffer, offset) / 100;
    return value > 0 ? value : null;
  };

  const lastTraded = mode === MODE_SNAP_QUOTE && buffer.length >= SNAP_QUOTE_MIN_BYTES ? readInt64(buffer, 123) : 0;

  return {
    exchange,
    token,
    exchangeTime: new Date(epochMs(readInt64(buffer, 35))),
    lastTradeTime: lastTraded > 0 ? new Date(epochMs(lastTraded)) : null,
    lastPrice: readInt64(buffer, 43) / 100,
    open: hasQuote ? rupees(91) : null,
    dayHigh: hasQuote ? rupees(99) : null,
    dayLow: hasQuote ? rupees(107) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                               */
/* -------------------------------------------------------------------------- */

export type TokenList = { exchangeType: number; tokens: string[] }[];

/**
 * Splits instruments into one subscribe payload per connection, at most 1,000 tokens
 * each. Throws past three connections' worth rather than silently dropping stocks.
 */
export function planConnections(instruments: readonly { exchange: Exchange; token: string }[]): TokenList[] {
  const limit = MAX_TOKENS_PER_CONNECTION * MAX_CONNECTIONS;
  if (instruments.length > limit) {
    throw new Error(`${instruments.length} instruments is more than Angel's limit of ${limit} on one account`);
  }

  const plans: TokenList[] = [];
  for (let start = 0; start < instruments.length; start += MAX_TOKENS_PER_CONNECTION) {
    const grouped = new Map<number, string[]>();
    for (const { exchange, token } of instruments.slice(start, start + MAX_TOKENS_PER_CONNECTION)) {
      const type = EXCHANGE_TYPE[exchange];
      const tokens = grouped.get(type) ?? [];
      tokens.push(token);
      grouped.set(type, tokens);
    }
    plans.push([...grouped].map(([exchangeType, tokens]) => ({ exchangeType, tokens })));
  }
  return plans;
}

/* -------------------------------------------------------------------------- */
/* Connections                                                                 */
/* -------------------------------------------------------------------------- */

export type FeedCredentials = {
  /** `Bearer <jwt>`. */
  authorization: string;
  apiKey: string;
  clientCode: string;
  feedToken: string;
};

export type MarketFeedOptions = {
  /** Read on every (re)connect, so a re-login's fresh tokens are picked up. */
  credentials: () => FeedCredentials;
  plans: TokenList[];
  onPacket: (packet: QuotePacket) => void;
  /**
   * Called when the server refuses the upgrade (HTTP 401/403): the session has expired or
   * was replaced by another login. Expected to log in again; the connection then retries.
   */
  onAuthRejected?: () => Promise<void>;
};

export type FeedStats = { connected: number; packets: number; reconnects: number };

class FeedConnection {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private lastMessageAt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private authRejected = false;
  packets = 0;
  reconnects = 0;

  constructor(
    private readonly index: number,
    private readonly plan: TokenList,
    private readonly options: MarketFeedOptions,
  ) {}

  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.clearHeartbeat();
    if (this.socket) {
      this.socket.removeAllListeners();
      // A no-op error listener stays attached: terminate() on a socket that is still
      // connecting emits one, and an unhandled 'error' would end the process.
      this.socket.on('error', () => undefined);
      this.socket.terminate();
      this.socket = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const credentials = this.options.credentials();
    const socket = new WebSocket(FEED_URL, {
      headers: {
        Authorization: credentials.authorization,
        'x-api-key': credentials.apiKey,
        'x-client-code': credentials.clientCode,
        'x-feed-token': credentials.feedToken,
      },
      handshakeTimeout: 15_000,
    });
    this.socket = socket;
    this.authRejected = false;

    socket.on('open', () => {
      this.lastMessageAt = Date.now();
      const request = {
        correlationID: `orbfeed${this.index}`,
        action: 1,
        params: { mode: MODE_SNAP_QUOTE, tokenList: this.plan },
      };
      socket.send(JSON.stringify(request));
      const tokens = this.plan.reduce((sum, group) => sum + group.tokens.length, 0);
      logger.info('Stock bot: market feed connected', { connection: this.index, tokens });
      this.startHeartbeat(socket);
    });

    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.lastMessageAt = Date.now();
      try {
        if (!isBinary) {
          const text = data.toString();
          if (text !== 'pong') {
            // Angel reports subscription errors as JSON text. Never echoes credentials.
            logger.warn('Stock bot: market feed message', { connection: this.index, text: text.slice(0, 200) });
          }
          return;
        }
        // A successful packet resets the backoff: the connection is proven, not just open.
        this.attempt = 0;
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        const packet = parsePacket(bytes);
        if (!packet) return;
        this.packets += 1;
        this.options.onPacket(packet);
      } catch (error) {
        logger.error('Stock bot: market packet handler failed', {
          connection: this.index,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      this.authRejected = status === 401 || status === 403;
      logger.warn('Stock bot: market feed refused the connection', { connection: this.index, status });
      socket.terminate();
    });

    socket.on('error', (error) => {
      logger.warn('Stock bot: market feed error', { connection: this.index, reason: error.message });
    });

    socket.on('close', () => {
      this.clearHeartbeat();
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) void this.scheduleReconnect();
    });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastMessageAt > SILENCE_LIMIT_MS) {
        logger.warn('Stock bot: market feed went silent; reconnecting', { connection: this.index });
        socket.terminate();
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send('ping');
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.authRejected && this.options.onAuthRejected) {
      try {
        await this.options.onAuthRejected();
      } catch (error) {
        logger.error('Stock bot: could not log in again for the market feed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.stopped) return;

    const delay = Math.min(RECONNECT_MIN_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt += 1;
    this.reconnects += 1;
    logger.info('Stock bot: market feed reconnecting', { connection: this.index, inMs: delay });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}

/** One or more SmartStream connections sharing the day's instruments. */
export class MarketFeed {
  private readonly connections: FeedConnection[];

  constructor(options: MarketFeedOptions) {
    this.connections = options.plans.map((plan, index) => new FeedConnection(index + 1, plan, options));
  }

  start(): void {
    for (const connection of this.connections) connection.start();
  }

  stop(): void {
    for (const connection of this.connections) connection.stop();
  }

  stats(): FeedStats {
    return {
      connected: this.connections.filter((connection) => connection.open).length,
      packets: this.connections.reduce((sum, connection) => sum + connection.packets, 0),
      reconnects: this.connections.reduce((sum, connection) => sum + connection.reconnects, 0),
    };
  }
}
