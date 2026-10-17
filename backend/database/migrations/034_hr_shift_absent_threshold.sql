-- =============================================================================
-- 034 — A shift's second threshold: under this many minutes, a finished day is absent
--
-- A shift judged a finished day against ONE number, `half_day_minutes`: worked less than
-- it, the day was a half day; otherwise a full day. HR asked for the usual two-step rule
-- instead — e.g. 7 hours or more is a full day, 3h30 or more a half day, and less than
-- that is absent — so a ten-minute appearance is no longer paid as half a day.
--
--   half_day_minutes  (unchanged) the FULL-DAY minimum: worked less is not a full day
--   absent_minutes    (new)       the HALF-DAY minimum: worked less is absent
--
-- 0 means "never absent for short hours", which is exactly the old behaviour, so every
-- existing shift keeps judging days as it did until an administrator sets a value.
-- Days are only re-judged when an administrator changes a shift's thresholds (see
-- `rejudgeShiftDays`), never by this migration.
-- =============================================================================

ALTER TABLE hr_shifts
  ADD COLUMN absent_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER half_day_minutes;
