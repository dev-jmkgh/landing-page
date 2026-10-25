import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config/env';
import { asyncHandler } from '../../middleware/errorHandler';
import { notFound } from '../../utils/httpError';
import { companyDate, companyDayStart } from '../telecalling/companyTime';
import { PAGE_SIZE, PAGE_STYLE_HASH, renderStatusPage } from './stockbot.page';
import * as repo from './stockbot.repository';

/**
 * `GET /api/stockbot/:token` — the trader's read-only status page.
 *
 * The trader has no account in any JMK app, so the credential is the secret in the link
 * itself (STOCKBOT_VIEW_TOKEN, 24+ characters). A wrong or missing token, and an unset
 * one, all answer the same 404 as any unknown path, so the page cannot be found by
 * probing. The comparison is constant-time. Changing the token revokes the old link.
 *
 * What it shows is the bot's own output — levels and breakouts of listed instruments —
 * never anything from the account itself (no holdings, balances or credentials).
 */

const MIN_TOKEN_LENGTH = 24;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function tokenMatches(given: string): boolean {
  const expected = config.stockbot.viewToken;
  if (expected.length < MIN_TOKEN_LENGTH) return false;
  // Equal-length digests, so timingSafeEqual never throws and leaks nothing about length.
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * The page's own query. Anything malformed is ignored rather than refused: this is a
 * page a person follows links on, and a mangled parameter should land on today's view.
 */
const querySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      try {
        companyDayStart(value);
        return true;
      } catch {
        return false;
      }
    })
    .optional()
    .catch(undefined),
  q: z
    .string()
    .trim()
    .max(20)
    .regex(/^[A-Za-z0-9&-]*$/)
    .transform((value) => value.toUpperCase() || null)
    .optional()
    .catch(undefined),
  lp: z.coerce.number().int().min(1).max(repo.PAGE_MAX).catch(1),
  bp: z.coerce.number().int().min(1).max(repo.PAGE_MAX).catch(1),
});

export const stockbotRouter = Router();

stockbotRouter.get(
  '/:token',
  asyncHandler(async (request, response) => {
    if (!tokenMatches(String(request.params.token ?? ''))) throw notFound();

    const query = querySchema.parse(request.query);
    const today = companyDate();
    const tradeDate = query.date ?? today;
    const search = query.q ?? null;

    /**
     * One page of a list, with a page past the end clamped to the last one (an old link
     * after a shorter day, a hand-edited number) instead of an empty table.
     */
    async function pageOf<T>(
      fetch: (limit: number, offset: number) => Promise<repo.PageSlice<T>>,
      requested: number,
    ): Promise<{ slice: repo.PageSlice<T>; page: number }> {
      const slice = await fetch(PAGE_SIZE, (requested - 1) * PAGE_SIZE);
      const last = Math.max(1, Math.ceil(slice.total / PAGE_SIZE));
      if (requested <= last) return { slice, page: requested };
      return { slice: await fetch(PAGE_SIZE, (last - 1) * PAGE_SIZE), page: last };
    }

    const [day, adjacent, levels, breakouts] = await Promise.all([
      repo.findDay(tradeDate),
      repo.adjacentDays(tradeDate),
      pageOf((limit, offset) => repo.levelsPage(tradeDate, search, limit, offset), query.lp),
      pageOf((limit, offset) => repo.breakoutsPage(tradeDate, search, limit, offset), query.bp),
    ]);

    const html = renderStatusPage({
      tradeDate,
      today,
      now: new Date(),
      day,
      adjacent,
      search,
      levels: levels.slice,
      levelsPage: levels.page,
      breakouts: breakouts.slice,
      breakoutsPage: breakouts.page,
    });

    response
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        // The token is in the address; never hand it to another site.
        'Referrer-Policy': 'no-referrer',
        // Replaces the API-wide `default-src 'none'` for this one HTML page: its own
        // stylesheet by hash, forms back to itself, nothing else.
        'Content-Security-Policy': [
          "default-src 'none'",
          `style-src '${PAGE_STYLE_HASH}'`,
          "form-action 'self'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
        ].join('; '),
      })
      .send(html);
  }),
);
