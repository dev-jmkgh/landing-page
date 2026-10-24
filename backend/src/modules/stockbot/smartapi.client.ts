import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from '../../utils/logger';
import { maskClientCode, type StockbotSettings } from './stockbot.config';
import { totpAt, totpSecondsLeft } from './totp';

/**
 * Angel One SmartAPI over plain HTTPS: login, holdings, logout.
 *
 * Written against the REST endpoints directly rather than through Angel's SDKs. The
 * official Python SDK logs whole request bodies — PIN and TOTP included — on any failed
 * call, and sends a hard-coded fake public IP header; the JavaScript one is unmaintained.
 * Three endpoints do not justify inheriting either. Nothing in this file logs a request
 * or response body.
 *
 * LOGIN RETRIES ARE DELIBERATELY NARROW. Angel locks an account after repeated failed
 * logins, so only failures that say nothing about the credentials are retried: network
 * errors, non-JSON gateway and rate-limit pages, and Angel's own "try again later" codes.
 * An invalid TOTP (AB1050) gets exactly one more try with the next code, since a code can
 * expire in flight. Every other refusal — a wrong PIN above all — fails at once.
 */

const API_ROOT = 'https://apiconnect.angelone.in';
const ROUTES = {
  login: '/rest/auth/angelbroking/user/v1/loginByPassword',
  logout: '/rest/secure/angelbroking/user/v1/logout',
  holdings: '/rest/secure/angelbroking/portfolio/v1/getHolding',
} as const;

const REQUEST_TIMEOUT_MS = 10_000;
const PUBLIC_IP_URL = 'https://api.ipify.org';
const PUBLIC_IP_TIMEOUT_MS = 5_000;

/** Angel's "Something went wrong / Internal error, please try after sometime". */
const TRANSIENT_CODES = new Set(['AB1004', 'AB2001']);
const INVALID_TOTP_CODE = 'AB1050';

const LOGIN_ATTEMPTS = 4;
const LOGIN_BASE_DELAY_MS = 2_000;
/** Never send a code with less than this left in its 30-second step. */
const MIN_TOTP_SECONDS_LEFT = 3;

/** Angel gave a definite answer, and asking again will not change it. */
export class AngelRefusedError extends Error {
  constructor(
    readonly what: string,
    readonly code: string | null,
    /** Angel's own words, e.g. "Invalid Password". Never contains a credential. */
    readonly detail: string,
  ) {
    super(`${what} refused: ${code ?? 'no code'} ${detail}`);
    this.name = 'AngelRefusedError';
  }
}

/** Angel could not be reached, or answered with something other than its API. */
export class AngelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AngelUnavailableError';
  }
}

type Envelope<T> = {
  status: boolean;
  message?: string;
  errorcode?: string;
  data?: T | null;
};

export type AngelSession = {
  clientCode: string;
  apiKey: string;
  /** Raw JWT; REST sends it as `Bearer <jwt>`, and so does the market-data socket. */
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  publicIp: string | null;
  /** True only when this machine's public IP is one of ANGEL_STATIC_IPS. */
  ordersAllowed: boolean | null;
  loggedInAt: Date;
  headers: Record<string, string>;
};

export type Holding = {
  tradingsymbol?: string;
  exchange?: string;
  symboltoken?: string | number;
  quantity?: number;
};

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/** This machine's LAN address and MAC, which Angel asks for in headers. */
function networkIdentity(): { localIp: string; mac: string } {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal && address.family === 'IPv4') {
        return { localIp: address.address, mac: address.mac };
      }
    }
  }
  return { localIp: '127.0.0.1', mac: '00:00:00:00:00:00' };
}

/** This machine's public IPv4 as Angel will see it, or null if it cannot be found out. */
export async function detectPublicIp(): Promise<string | null> {
  try {
    const response = await fetch(PUBLIC_IP_URL, { signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS) });
    const text = (await response.text()).trim();
    return response.ok && /^\d{1,3}(\.\d{1,3}){3}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function baseHeaders(apiKey: string, publicIp: string): Record<string, string> {
  const { localIp, mac } = networkIdentity();
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': localIp,
    'X-ClientPublicIP': publicIp,
    'X-MACAddress': mac,
    'X-PrivateKey': apiKey,
  };
}

async function call<T>(
  what: string,
  route: string,
  options: { method: 'GET' | 'POST'; headers: Record<string, string>; jwt?: string; body?: unknown },
): Promise<Envelope<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${route}`, {
      method: options.method,
      headers: options.jwt ? { ...options.headers, Authorization: `Bearer ${options.jwt}` } : options.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new AngelUnavailableError(`${what}: ${reason}`);
  }

  // Rate-limit rejections and gateway errors come back as text or HTML, not the API's
  // JSON envelope. They say nothing about the request, so they are worth a retry.
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AngelUnavailableError(`${what}: HTTP ${response.status} with a non-JSON reply`);
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Envelope<T>).status !== 'boolean') {
    throw new AngelUnavailableError(`${what}: HTTP ${response.status} with an unexpected reply`);
  }
  return parsed as Envelope<T>;
}

/** The data of a successful reply; a refusal or a "try later" otherwise. */
function unwrap<T>(what: string, envelope: Envelope<T>): T | null {
  if (envelope.status) return envelope.data ?? null;
  const code = envelope.errorcode || null;
  const message = envelope.message || 'no message';
  if (code && TRANSIENT_CODES.has(code)) throw new AngelUnavailableError(`${what}: ${code} ${message}`);
  throw new AngelRefusedError(what, code, message);
}

async function withRetries<T>(
  what: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof AngelUnavailableError) || attempt >= attempts) throw error;
      const delay = 1_000 * 2 ** (attempt - 1);
      logger.warn('SmartAPI call failed; retrying', { what, reason: error.message, retryInMs: delay });
      await sleep(delay, undefined, { signal });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Login                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A code with at least MIN_TOTP_SECONDS_LEFT to live that differs from `previous`,
 * waiting for the next step when needed.
 */
async function freshTotp(secret: Buffer, previous: string | null, signal?: AbortSignal): Promise<string> {
  for (;;) {
    const now = Date.now();
    const code = totpAt(secret, now);
    const left = totpSecondsLeft(now);
    if (left >= MIN_TOTP_SECONDS_LEFT && code !== previous) return code;
    await sleep(Math.ceil(left * 1000) + 100, undefined, { signal });
  }
}

type LoginData = { jwtToken?: string; refreshToken?: string; feedToken?: string };

export async function login(settings: StockbotSettings, signal?: AbortSignal): Promise<AngelSession> {
  const publicIp = await detectPublicIp();
  const ordersAllowed =
    settings.staticIps.length === 0 || publicIp === null ? null : settings.staticIps.includes(publicIp);

  if (ordersAllowed === false) {
    logger.warn('Stock bot: this machine is not a registered static IP; Angel will refuse orders from it', {
      publicIp,
      registered: settings.staticIps,
    });
  }

  // The real address, or the first registered one when it cannot be detected — never the
  // placeholder Angel's own SDK sends.
  const headers = baseHeaders(settings.apiKey, publicIp ?? settings.staticIps[0] ?? '127.0.0.1');
  const client = maskClientCode(settings.clientCode);

  let previous: string | null = null;
  let totpRetried = false;
  let failure = 'no attempt made';

  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt += 1) {
    const code = await freshTotp(settings.totpSecret, previous, signal);
    previous = code;

    let envelope: Envelope<LoginData> | null = null;
    try {
      envelope = await call<LoginData>('login', ROUTES.login, {
        method: 'POST',
        headers,
        body: { clientcode: settings.clientCode, password: settings.pin, totp: code },
      });
    } catch (error) {
      if (!(error instanceof AngelUnavailableError)) throw error;
      failure = error.message;
    }

    if (envelope) {
      const data = envelope.data;
      if (envelope.status && data?.jwtToken && data.refreshToken && data.feedToken) {
        logger.info('Stock bot: logged in to SmartAPI', { client, publicIp, ordersAllowed });
        return {
          clientCode: settings.clientCode,
          apiKey: settings.apiKey,
          jwtToken: data.jwtToken,
          refreshToken: data.refreshToken,
          feedToken: data.feedToken,
          publicIp,
          ordersAllowed,
          loggedInAt: new Date(),
          headers,
        };
      }
      if (envelope.status) {
        throw new AngelRefusedError('login', null, 'succeeded without returning session tokens');
      }

      const errorCode = envelope.errorcode || null;
      const message = envelope.message || 'no message';
      if (errorCode === INVALID_TOTP_CODE) {
        if (totpRetried) {
          throw new AngelRefusedError(
            'login',
            errorCode,
            'TOTP rejected twice. Check ANGEL_TOTP_SECRET and that the server clock is synced.',
          );
        }
        totpRetried = true;
        failure = `${errorCode} ${message}`;
        logger.warn('Stock bot: TOTP rejected; retrying once with the next code', { client });
        continue; // freshTotp waits for the next step; no backoff needed
      }
      if (!errorCode || !TRANSIENT_CODES.has(errorCode)) {
        throw new AngelRefusedError('login', errorCode, message);
      }
      failure = `${errorCode} ${message}`;
    }

    if (attempt < LOGIN_ATTEMPTS) {
      const delay = LOGIN_BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.warn('Stock bot: login attempt failed; retrying', { client, attempt, reason: failure, retryInMs: delay });
      await sleep(delay, undefined, { signal });
    }
  }

  throw new AngelUnavailableError(`login failed after ${LOGIN_ATTEMPTS} attempts: ${failure}`);
}

/* -------------------------------------------------------------------------- */
/* Session calls                                                               */
/* -------------------------------------------------------------------------- */

export async function fetchHoldings(session: AngelSession, signal?: AbortSignal): Promise<Holding[]> {
  const data = await withRetries(
    'holdings',
    async () =>
      unwrap(
        'holdings',
        await call<Holding[]>('holdings', ROUTES.holdings, {
          method: 'GET',
          headers: session.headers,
          jwt: session.jwtToken,
        }),
      ),
    signal,
  );
  // Angel answers `data: null` for an empty portfolio.
  return Array.isArray(data) ? data : [];
}

/** Ends the session. Best effort: it expires on its own, so a failure is only logged. */
export async function logout(session: AngelSession): Promise<void> {
  try {
    const envelope = await call<unknown>('logout', ROUTES.logout, {
      method: 'POST',
      headers: session.headers,
      jwt: session.jwtToken,
      body: { clientcode: session.clientCode },
    });
    if (envelope.status) logger.info('Stock bot: logged out of SmartAPI');
    else logger.warn('Stock bot: logout not confirmed', { code: envelope.errorcode, message: envelope.message });
  } catch (error) {
    logger.warn('Stock bot: logout failed; the session expires on its own', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
