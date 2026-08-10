import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { config } from '../config/env';
import { forbidden, unauthorized } from '../utils/httpError';
import { verifySession } from '../modules/admin/auth.service';

/** Rejects the request unless it carries a valid admin session cookie. */
export const requireAuth: RequestHandler = (request, _response, next) => {
  const token = request.cookies?.[config.admin.sessionCookieName];

  if (typeof token !== 'string' || token.length === 0) {
    next(unauthorized('Please sign in to continue.'));
    return;
  }

  const payload = verifySession(token);

  if (!payload) {
    next(unauthorized('Your session has expired. Please sign in again.'));
    return;
  }

  request.admin = { email: payload.sub, csrf: payload.csrf };
  next();
};

function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * CSRF protection for state-changing admin routes.
 *
 * The token is minted at sign-in, embedded in the signed session token and mirrored in
 * a JavaScript-readable cookie. A cross-site request can send the cookie but cannot
 * read it to set the `X-CSRF-Token` header, so the two will not match.
 */
export const requireCsrf: RequestHandler = (request, _response, next) => {
  if (!request.admin) {
    next(unauthorized());
    return;
  }

  const header = request.get('X-CSRF-Token');

  if (!header || !timingSafeEqual(header, request.admin.csrf)) {
    next(forbidden('Your session could not be verified. Please refresh the page and try again.'));
    return;
  }

  next();
};
