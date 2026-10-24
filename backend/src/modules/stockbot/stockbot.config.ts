import { isIPv4 } from 'node:net';
import path from 'node:path';
import { config } from '../../config/env';
import { EXCHANGES, type Exchange } from './stockbot.schema';
import { base32Decode } from './totp';

/**
 * The bot's settings, validated.
 *
 * `config/env.ts` only reads the raw strings. Validation lives here so that a bad trading
 * credential switches the bot off with a clear line in the log while the website's API
 * starts as usual. Problems name the variable and never echo its value.
 */

export type StockbotSettings = {
  clientCode: string;
  pin: string;
  totpSecret: Buffer;
  apiKey: string;
  /** IPs registered on the SmartAPI app. Orders are accepted only from these. */
  staticIps: string[];
  preferredExchange: Exchange;
  dataDirectory: string;
  watchlistFile: string;
  cacheDirectory: string;
};

export type StockbotSettingsResult =
  | { ok: true; settings: StockbotSettings }
  | { ok: false; configured: boolean; problems: string[] };

export function loadStockbotSettings(): StockbotSettingsResult {
  const raw = config.stockbot;
  const required = {
    ANGEL_CLIENT_ID: raw.clientId,
    ANGEL_PIN: raw.pin,
    ANGEL_TOTP_SECRET: raw.totpSecret.trim(),
    ANGEL_API_KEY: raw.apiKey,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  // None set at all is the normal state of every deployment that does not trade.
  if (missing.length === Object.keys(required).length) {
    return { ok: false, configured: false, problems: [`${missing.join(', ')} not set`] };
  }

  const problems: string[] = [];
  if (missing.length > 0) problems.push(`missing ${missing.join(', ')}`);

  if (raw.pin && !/^\d{4,8}$/.test(raw.pin)) problems.push('ANGEL_PIN must be the numeric MPIN');

  let totpSecret: Buffer | null = null;
  if (required.ANGEL_TOTP_SECRET) {
    try {
      totpSecret = base32Decode(required.ANGEL_TOTP_SECRET);
    } catch {
      problems.push('ANGEL_TOTP_SECRET is not a valid base32 secret');
    }
  }

  const staticIps = raw.staticIps
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (staticIps.some((ip) => !isIPv4(ip))) {
    problems.push('ANGEL_STATIC_IPS must be IPv4 addresses, comma-separated (Angel accepts only IPv4)');
  }

  const preferred = EXCHANGES.find((exchange) => exchange === raw.preferredExchange);
  if (!preferred) problems.push(`STOCKBOT_PREFERRED_EXCHANGE must be ${EXCHANGES.join(' or ')}`);

  if (problems.length > 0 || !totpSecret || !preferred) {
    return { ok: false, configured: true, problems };
  }

  return {
    ok: true,
    settings: {
      clientCode: raw.clientId.toUpperCase(),
      pin: raw.pin,
      totpSecret,
      apiKey: raw.apiKey,
      staticIps,
      preferredExchange: preferred,
      dataDirectory: raw.dataDirectory,
      watchlistFile: path.join(raw.dataDirectory, 'watchlists.json'),
      cacheDirectory: path.join(raw.dataDirectory, 'cache'),
    },
  };
}

/** `A12345678` -> `A12***678`, for logs and emails. */
export function maskClientCode(value: string): string {
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-3)}`;
}
