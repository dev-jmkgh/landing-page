import type { Request } from 'express';

/**
 * Client IP for rate limiting and abuse logging.
 *
 * Express only trusts `X-Forwarded-For` when TRUST_PROXY is enabled, so `request.ip`
 * is already the correct value for the deployment; this helper just normalises the
 * IPv4-mapped IPv6 form and caps the length for the VARCHAR(45) column.
 */
export function clientIp(request: Request): string | null {
  const raw = request.ip ?? request.socket.remoteAddress ?? null;
  if (!raw) return null;

  const normalised = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return normalised.slice(0, 45);
}
