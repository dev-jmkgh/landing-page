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
