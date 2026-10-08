import { z } from 'zod';
import { GRANULARITIES } from '../companyTime';

/**
 * Request contracts for the dashboard (spec: Admin Module 2).
 *
 * The tiles take the shared `dateRangeSchema`; this file holds what the trend charts add
 * to it.
 */

/**
 * What a client may ask the charts to be bucketed by. `auto` lets the server choose from
 * the length of the range (see `resolveGranularity`), and is what a screen sends until
 * someone picks a granularity themselves.
 */
export const ANALYTICS_GRANULARITIES = ['auto', ...GRANULARITIES] as const;
export type AnalyticsGranularity = (typeof ANALYTICS_GRANULARITIES)[number];

/**
 * GET /dashboard/analytics.
 *
 * `from` and `to` are inclusive IST calendar dates — exactly what the range picker sends
 * to the tiles, so the two requests always describe the same period. A missing `from`
 * means "since the first call or lead", a missing `to` means today.
 *
 * A reversed range is refused here rather than charted as nothing: an empty chart reads
 * as "no activity", which is a claim about the business, not about the request.
 */
export const analyticsQuerySchema = z
  .object({
    from: z.string().date('Expected YYYY-MM-DD.').optional(),
    to: z.string().date('Expected YYYY-MM-DD.').optional(),
    granularity: z.enum(ANALYTICS_GRANULARITIES).default('auto'),
    /** One employee's calls, assigned leads and follow-ups. */
    userId: z.coerce.number().int().positive().optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['from'],
    message: 'The start date must be on or before the end date.',
  });

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
