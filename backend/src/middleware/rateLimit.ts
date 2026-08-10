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
