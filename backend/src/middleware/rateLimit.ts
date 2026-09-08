import rateLimit, { type Options } from 'express-rate-limit';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * IP-based rate limiting.
 *
 * The public form endpoints get a much tighter budget than general traffic — they are
 * the endpoints that write to the database and send email.
 */

function build(options: {
  windowMs: number;
  max: number;
  message: string;
  name: string;
  /**
   * Overrides the default IP key.
   *
   * Needed because IP is the wrong identity for some endpoints: an office of telecallers
   * behind one address would share a counter, so one person exhausting it would lock out
   * their colleagues.
   */
  keyBy?: (request: Parameters<NonNullable<Options['keyGenerator']>>[0]) => string;
}): ReturnType<typeof rateLimit> {
  const handler: Options['handler'] = (request, response) => {
    logger.warn('Rate limit exceeded', {
      limiter: options.name,
      ip: request.ip,
      path: request.originalUrl,
    });
    response.status(429).json({
      success: false,
      code: 'rate_limited',
      message: options.message,
    });
  };

  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler,
    ...(options.keyBy ? { keyGenerator: options.keyBy } : {}),
  });
}

/** Baseline limit applied to the whole API. */
export const globalLimiter = build({
  name: 'global',
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: 'Too many requests. Please wait a few minutes and try again.',
});

/**
 * Public enquiry submissions. Separate instances mean separate counters, so a visitor
 * who sends an enquiry is not blocked from also submitting a job application.
 */
export const enquiryLimiter = build({
  name: 'enquiries',
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.formMax,
  message:
    'You have submitted several times in a short period. Please wait a few minutes before sending another message.',
});

/** Career application submissions. */
export const applicationLimiter = build({
  name: 'applications',
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.formMax,
  message:
    'You have submitted several applications in a short period. Please wait a few minutes before trying again.',
});

/** Admin sign-in, to blunt credential stuffing. */
export const loginLimiter = build({
  name: 'login',
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.loginMax,
  message: 'Too many sign-in attempts. Please wait before trying again.',
});

/**
 * Mobile employee sign-in. A separate counter from the admin limiter, because a whole
 * office of telecallers can share one office IP — putting them on the admin budget
 * would lock out the morning shift.
 */
export const mobileLoginLimiter = build({
  name: 'mobile-login',
  windowMs: config.rateLimit.windowMs,
  max: config.mobileAuth.loginMax,
  message: 'Too many sign-in attempts. Please wait before trying again.',
});

/**
 * Self-registration.
 *
 * Much tighter than sign-in. This endpoint is unauthenticated, reachable by anyone who
 * has the APK — which is being handed around on WhatsApp — and every call writes a row
 * and burns a bcrypt hash at cost 12 (~250ms of CPU). Left ungoverned it is both a
 * table-flooding vector and a cheap way to saturate the process.
 *
 * Five per window, not three. Three was the first choice and it is too tight: a
 * rejected attempt counts, so someone who mistypes their email, then trips the
 * twelve-character password rule twice, is locked out before submitting anything valid.
 * The e2e suite hit exactly that. Five still bounds the abuse this is here to stop —
 * every call writes a row and burns a ~250ms bcrypt hash — while tolerating a real
 * person getting the form wrong.
 *
 * The counter is separate from the sign-in limiter so a failed registration cannot lock
 * a colleague out of signing in from the same office IP.
 */
export const signupLimiter = build({
  name: 'mobile-signup',
  windowMs: config.rateLimit.windowMs,
  max: 5,
  message:
    'Too many registration attempts from this network. Please wait a few minutes, or ask your administrator to create the account for you.',
});

/**
 * Refresh-token exchange. Generous: a phone coming back onto the network drains a queue
 * of pending mutations and may legitimately refresh more than once. Limited at all only
 * so a stolen refresh token cannot be used to hammer the endpoint.
 */
export const refreshLimiter = build({
  name: 'mobile-refresh',
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: 'Too many refresh attempts. Please wait a moment.',
});

/**
 * Self-service password change.
 *
 * This endpoint verifies the caller's CURRENT password, so without a limit it is a
 * password-guessing oracle for anyone holding an unlocked handset — and a success mints a
 * fresh 60-day refresh row.
 *
 * Keyed on the authenticated employee rather than the IP: a whole floor of telecallers
 * shares one office address, and an IP key would let one person's attempts lock out
 * everyone else's legitimate password change.
 */
export const changePasswordLimiter = build({
  name: 'mobile-change-password',
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyBy: (request) =>
    request.actor ? `actor:${request.actor.id}` : `ip:${request.ip ?? 'unknown'}`,
  message: 'Too many password change attempts. Please wait before trying again.',
});

/**
 * Mobile write endpoints — call logs, notes, status changes.
 *
 * The offline queue can drain dozens of mutations in a burst when a telecaller walks
 * back into signal, so this has to be wide enough for a genuine day's backlog. It
 * exists to stop a runaway retry loop, not to pace normal use.
 */
export const mobileSyncLimiter = build({
  name: 'mobile-sync',
  windowMs: 60 * 1000,
  max: 240,
  message: 'Too many updates at once. They will be retried automatically.',
});
