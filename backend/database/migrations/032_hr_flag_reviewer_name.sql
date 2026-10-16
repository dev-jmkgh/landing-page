-- =============================================================================
-- 032 — Who reviewed an attendance exception, by name
--
-- 028 recorded the reviewer of a flagged or missing-punch day as an admin
-- portal id only. The HR module may not read the telecalling account tables
-- (see 017), so the exceptions screen could say WHEN a day was reviewed but not
-- by whom. The name is snapshotted here at review time, the same way
-- hr_regularisations.reviewer_name and hr_leave_requests.reviewer_name are.
-- =============================================================================

ALTER TABLE hr_attendance
  ADD COLUMN flag_reviewer_name VARCHAR(120) NULL AFTER flag_reviewed_by;
