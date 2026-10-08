-- =============================================================================
-- 025 — Conversion dates for leads that were created already converted
--
-- `converted_at` was only ever set by a status CHANGE (updateLeadStatusTx). A
-- lead entered with status 'converted' - typed in by an admin after the sale, or
-- imported from a spreadsheet - never got one, so every conversion-by-date
-- figure (Reports, the dashboard chart, the daily email) silently missed it.
-- The insert now sets it, and this gives the existing rows the best date there
-- is for them: when they were entered.
--
-- Run through `npm run db:migrate`, whose pool pins the session to UTC
-- (db/pool.ts), so copying the TIMESTAMP created_at into the DATETIME
-- converted_at keeps the UTC wall clock every other DATETIME holds. Applied by
-- hand from a session in another zone, it would shift each date by that zone's
-- offset.
--
-- Idempotent: only rows still missing a date are touched.
-- =============================================================================

UPDATE leads SET converted_at = created_at WHERE status = 'converted' AND converted_at IS NULL;
