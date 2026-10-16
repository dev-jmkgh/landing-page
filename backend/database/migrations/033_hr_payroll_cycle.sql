-- =============================================================================
-- 033 — Pay periods that can be calculated while they run, and say who is missing
--
-- Three things HR asked for once payroll met real use:
--
--   1. A COMMON PAY CYCLE. Pay periods were calendar months. Many companies run
--      26th-to-25th instead, so the period now follows the HR setting
--      `payroll_cycle_start_day` (1 to 28, default 1). The bounds are worked out
--      when a period is created and stored on it, so changing the setting later
--      never moves a period that already exists.
--
--   2. CALCULATE ANY TIME. A period could only be processed after it ended, so in
--      the middle of the month HR had nothing to look at. It may now be calculated
--      once it has started. Days that have not happened yet are neither paid nor
--      loss of pay — they are `remaining_days` — and `calculated_through` records
--      the last day the figures cover. Approval still waits for a calculation made
--      after the period ended, so no published payslip ever contains a guess.
--
--   3. WHO WAS LEFT OUT. A calculation that paid nobody said "0 employees" and
--      nothing else. `exclusions` lists every employed person it left out and why
--      (no salary structure, or one that only starts after the period), so the
--      screen can name them.
--
-- And one correction to the attendance arithmetic payroll reads:
--
--   4. A SHORT DAY IS A HALF DAY EVEN WHEN IT STARTED LATE. The half-day rule
--      only downgraded 'present', so a day that began late kept 'late' however
--      little was worked — seven minutes counted as a full paid day. The rule now
--      applies to late days too (the minutes late are still on the row), and the
--      UPDATE below corrects the closed days already recorded that way.
-- =============================================================================

ALTER TABLE hr_payroll_runs
  ADD COLUMN calculated_through DATE NULL AFTER status,
  ADD COLUMN exclusions JSON NULL AFTER calculated_through;

ALTER TABLE hr_payslips
  ADD COLUMN remaining_days DECIMAL(5,1) NOT NULL DEFAULT 0 AFTER untracked_days;

-- Runs processed before this migration could only have been processed after their
-- period ended, so they cover all of it.
UPDATE hr_payroll_runs
   SET calculated_through = period_end
 WHERE status IN ('processed','approved') AND calculated_through IS NULL;

-- The status is now derived from the totals every time a day is recomputed (see
-- recomputeDayFor). These two bring the days already recorded into line with it.
--
-- Half days that later sessions took past the threshold: no longer half days.
UPDATE hr_attendance a
  JOIN hr_shifts s ON s.id = a.shift_id
   SET a.status = IF(a.late_minutes > 0, 'late', 'present')
 WHERE a.status = 'half_day'
   AND a.checked_out_at IS NOT NULL
   AND a.worked_minutes IS NOT NULL
   AND a.worked_minutes >= s.half_day_minutes;

-- Closed late days shorter than their shift's half-day threshold.
UPDATE hr_attendance a
  JOIN hr_shifts s ON s.id = a.shift_id
   SET a.status = 'half_day'
 WHERE a.status = 'late'
   AND a.checked_out_at IS NOT NULL
   AND a.worked_minutes IS NOT NULL
   AND a.worked_minutes < s.half_day_minutes;
