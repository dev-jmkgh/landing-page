import { config } from '../config/env';
import { describeError, logger } from '../utils/logger';

/**
 * Google reCAPTCHA verification.
 *
 * The site is configured with a reCAPTCHA **v2 checkbox**, so a token only exists once
 * the visitor has solved the challenge. The verification response for v2 carries no
 * score; the score branch below is kept so a v3 key can be swapped in without touching
 * any calling code.
 *
 * Verification is skipped entirely when RECAPTCHA_SECRET_KEY is empty, which is what
 * keeps local development working without keys.
 */

const VERIFY_ENDPOINT = 'https://www.google.com/recaptcha/api/siteverify';
const VERIFY_TIMEOUT_MS = 8_000;

type SiteVerifyResponse = {
  success: boolean;
  score?: number;
  action?: string;
  challenge_ts?: string;
  hostname?: string;
  'error-codes'?: string[];
};

export type RecaptchaResult =
  | { ok: true; skipped: boolean }
  | { ok: false; reason: 'missing_token' | 'rejected' | 'low_score' | 'unavailable' };

export function isRecaptchaEnabled(): boolean {
  return config.recaptcha.enabled;
}

/**
 * Verifies a client token with Google.
 *
 * A network failure returns `unavailable` rather than throwing, so the caller decides
 * whether to fail open or closed — losing a genuine enquiry because Google was briefly
 * unreachable is worse than letting one through.
 */
export async function verifyRecaptcha(
  token: string | undefined,
  remoteIp: string | null,
): Promise<RecaptchaResult> {
  if (!config.recaptcha.enabled) return { ok: true, skipped: true };

  if (!token || token.trim().length === 0) return { ok: false, reason: 'missing_token' };

  const body = new URLSearchParams({
    secret: config.recaptcha.secretKey,
    response: token,
  });
  if (remoteIp) body.set('remoteip', remoteIp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn('reCAPTCHA verification endpoint returned an error status', {
        status: response.status,
      });
      return { ok: false, reason: 'unavailable' };
    }

    const result = (await response.json()) as SiteVerifyResponse;

    if (!result.success) {
      // Error codes are Google's, not the visitor's — safe and useful to log.
      logger.warn('reCAPTCHA rejected a submission', { errors: result['error-codes'] ?? [] });
      return { ok: false, reason: 'rejected' };
    }

    // v3 only: v2 responses have no score and fall straight through.
    if (typeof result.score === 'number' && result.score < config.recaptcha.minimumScore) {
      logger.warn('reCAPTCHA score below threshold', {
        score: result.score,
        threshold: config.recaptcha.minimumScore,
      });
      return { ok: false, reason: 'low_score' };
    }

    return { ok: true, skipped: false };
  } catch (error) {
    logger.error('reCAPTCHA verification failed', describeError(error));
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
