-- =============================================================================
-- 038 — Deleting an HR employee, and compensatory leave
--
-- 1. DELETING AN EMPLOYEE IS A SOFT DELETE. The row stays, so their attendance,
--    leave and approved payslips keep the name they were recorded under, and the
--    payroll already paid stays reconcilable. `deleted_at` takes them out of every
--    list, every scheduler job and every pay period not yet approved; `is_active`
--    is cleared at the same moment, so they cannot sign in. Their email and mobile
--    number stay reserved by the row.
--
-- 2. COMPENSATORY LEAVE: a day off earned by working a full day on a weekly off or
--    a holiday. It is a leave type like the others (kind 'leave', paid), marked
--    `is_comp_off`. Each request names the day worked to earn it
--    (`comp_off_earned_on`); the hours are checked from attendance, never typed in.
--
--    ONE WORKED DAY, ONE DAY OFF, enforced here: `comp_off_claim` holds the worked
--    day while the request is pending or approved and NULL otherwise, and a UNIQUE
--    key ignores NULLs. Two requests can therefore never hold the same worked day
--    at once, however they race, while a rejected or cancelled one frees it.
--    (The same generated-column technique as migration 019's open_marker.)
-- =============================================================================

ALTER TABLE hr_users
  ADD COLUMN deleted_at      DATETIME     NULL,
  ADD COLUMN deleted_by_name VARCHAR(120) NULL;

ALTER TABLE hr_leave_types
  ADD COLUMN is_comp_off TINYINT(1) NOT NULL DEFAULT 0 AFTER kind;

ALTER TABLE hr_leave_requests
  ADD COLUMN comp_off_earned_on DATE NULL AFTER half_day,
  ADD COLUMN comp_off_claim DATE
    GENERATED ALWAYS AS (IF(status IN ('pending','approved'), comp_off_earned_on, NULL)) STORED,
  ADD UNIQUE KEY uq_hr_leave_requests_comp_off (user_id, comp_off_claim);

-- The type itself. Untracked in the quota sense (no annual_quota): its balance is
-- the worked days not yet used, computed from attendance. Never a half day — one
-- worked day earns one whole day off.
INSERT INTO hr_leave_types (name, code, kind, is_comp_off, is_paid, annual_quota, allow_half_day, sort_order)
SELECT 'Compensatory leave', 'COMPOFF', 'leave', 1, 1, NULL, 0, 35
 WHERE NOT EXISTS (SELECT 1 FROM hr_leave_types WHERE name = 'Compensatory leave' OR code = 'COMPOFF');

-- A type HR already created by hand under this name becomes the real one, rather
-- than a second, ordinary "Compensatory leave" sitting beside it.
UPDATE hr_leave_types
   SET is_comp_off = 1, kind = 'leave', annual_quota = NULL, allow_half_day = 0
 WHERE name = 'Compensatory leave' OR code = 'COMPOFF';
