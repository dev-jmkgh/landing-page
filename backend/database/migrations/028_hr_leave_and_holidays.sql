-- =============================================================================
-- 028 — Leave, holidays, weekly offs, and attendance exceptions
--
-- Leave arrives here, and with it the two calendar facts every later module
-- leans on: which days are HOLIDAYS and which are WEEKLY OFFS. Payroll's loss of
-- pay, the attendance register's "absent" and the number of days a leave request
-- costs are all the same question underneath — was this a working day for this
-- person, and if so, were they here, on leave, or neither?
--
-- THE RULE FOR BALANCES: DERIVED, NEVER ACCUMULATED.
--
-- A balance is entitlement minus approved days minus pending days, computed when
-- it is read. There is no `used_days` column to keep in step, so a cancelled or
-- re-decided request cannot leave a balance that disagrees with the requests
-- behind it. The same reasoning as the attendance roll-up in 019.
--
-- Leave days are NOT written into hr_attendance. An approved leave covering next
-- Tuesday does not create a row for next Tuesday: the register and payroll ask
-- the leave table directly. Writing ahead would collide with the unique day key
-- the moment that person checked in on a day they had booked off.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Weekly offs, per shift
-- -----------------------------------------------------------------------------
--
-- A SET, so a shift can rest on any combination of days. An employee with no
-- shift falls back to the `default_weekly_off` HR setting (migration 027).
ALTER TABLE hr_shifts
  ADD COLUMN weekly_off_days SET('sun','mon','tue','wed','thu','fri','sat')
    NOT NULL DEFAULT 'sun' AFTER half_day_minutes;

-- -----------------------------------------------------------------------------
-- Holidays
-- -----------------------------------------------------------------------------
--
-- One row per date. An optional (restricted) holiday is shown on the calendar
-- but is not a day off unless the employee takes leave for it.
CREATE TABLE IF NOT EXISTS hr_holidays (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  holiday_date  DATE            NOT NULL,
  name          VARCHAR(120)    NOT NULL,
  is_optional   TINYINT(1)      NOT NULL DEFAULT 0,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_holidays_date (holiday_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Leave types
-- -----------------------------------------------------------------------------
--
-- `kind` separates real leave from the two day-level work arrangements the
-- requirements ask for, which use the same apply-and-approve flow:
--
--   leave  — a day off. Paid or unpaid per `is_paid`.
--   wfh    — working from home that day. Not a day off, and the geofence does
--            not apply to that day's punches.
--   field  — out on field work that day. Same treatment as wfh.
--
-- `annual_quota` NULL means the type is UNTRACKED: requests are approved or not,
-- but there is no balance to show or exhaust. That is the honest state for a
-- type HR has not yet set an entitlement for, and permanently right for wfh,
-- field work and unpaid leave.
CREATE TABLE IF NOT EXISTS hr_leave_types (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(80)     NOT NULL,
  code            VARCHAR(16)     NOT NULL,
  kind            ENUM('leave','wfh','field') NOT NULL DEFAULT 'leave',
  is_paid         TINYINT(1)      NOT NULL DEFAULT 1,
  annual_quota    DECIMAL(5,1)    NULL,
  allow_half_day  TINYINT(1)      NOT NULL DEFAULT 1,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order      SMALLINT        NOT NULL DEFAULT 0,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_leave_types_name (name),
  UNIQUE KEY uq_hr_leave_types_code (code),
  KEY idx_hr_leave_types_active (is_active, sort_order)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Allocations — one person's entitlement for one type in one year
-- -----------------------------------------------------------------------------
--
-- Overrides the type's annual_quota for that person and year: a mid-year joiner
-- gets a pro-rated number, a carried-forward balance is added here. Absent a
-- row, the type's quota applies.
CREATE TABLE IF NOT EXISTS hr_leave_allocations (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  leave_type_id  BIGINT UNSIGNED NOT NULL,
  year           SMALLINT UNSIGNED NOT NULL,
  days           DECIMAL(5,1)    NOT NULL,
  note           VARCHAR(255)    NULL,
  -- An admin_users / telecaller_users id from the admin portal. Not a foreign
  -- key, for the audit reason given in 017.
  updated_by     BIGINT UNSIGNED NULL,
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_leave_allocations (user_id, leave_type_id, year),
  CONSTRAINT fk_hr_leave_alloc_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_hr_leave_alloc_type
    FOREIGN KEY (leave_type_id) REFERENCES hr_leave_types (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Leave requests
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  leave_type_id   BIGINT UNSIGNED NOT NULL,

  start_date      DATE            NOT NULL,
  end_date        DATE            NOT NULL,

  -- A half day is only ever a single-day request. 'none' for everything else.
  half_day        ENUM('none','first_half','second_half') NOT NULL DEFAULT 'none',

  -- Working days the request covers, computed by the server when it was raised:
  -- weekly offs and holidays inside the range cost nothing. A snapshot, so a
  -- holiday added later does not silently change what was approved.
  days            DECIMAL(5,1)    NOT NULL,

  reason          VARCHAR(500)    NOT NULL,
  status          ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',

  -- Generated by the app once per submission and reused on retry, so a request
  -- sent twice over a flaky connection is one request. NULL from the admin side.
  client_key      VARCHAR(64)     NULL,

  -- Who decided. `reviewer_type` says which id space reviewed_by belongs to:
  -- 'admin' is the admin portal's actor, 'manager' is an hr_users id (a team
  -- manager deciding in the app). Not a foreign key, for the audit reason in 017.
  reviewed_by     BIGINT UNSIGNED NULL,
  reviewer_type   ENUM('admin','manager') NULL,
  reviewer_name   VARCHAR(120)    NULL,
  reviewed_at     DATETIME        NULL,
  review_note     VARCHAR(500)    NULL,
  cancelled_at    DATETIME        NULL,

  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_leave_requests_client (user_id, client_key),
  KEY idx_hr_leave_requests_user (user_id, start_date),
  KEY idx_hr_leave_requests_queue (status, created_at),
  KEY idx_hr_leave_requests_range (status, start_date, end_date),
  CONSTRAINT fk_hr_leave_req_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE,
  -- RESTRICT: a type with requests against it is deactivated, not deleted.
  CONSTRAINT fk_hr_leave_req_type
    FOREIGN KEY (leave_type_id) REFERENCES hr_leave_types (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Starting leave types
-- -----------------------------------------------------------------------------
--
-- Names only, with NO quota. A leave balance is a claim about somebody's
-- entitlement that they will plan around, and this migration does not know the
-- company's policy. HR sets each quota in the admin portal; until then the type
-- is untracked and the app shows no balance for it rather than an invented one.
INSERT INTO hr_leave_types (name, code, kind, is_paid, allow_half_day, sort_order)
SELECT 'Casual leave', 'CL', 'leave', 1, 1, 10
 WHERE NOT EXISTS (SELECT 1 FROM hr_leave_types WHERE code = 'CL');
INSERT INTO hr_leave_types (name, code, kind, is_paid, allow_half_day, sort_order)
SELECT 'Sick leave', 'SL', 'leave', 1, 1, 20
 WHERE NOT EXISTS (SELECT 1 FROM hr_leave_types WHERE code = 'SL');
INSERT INTO hr_leave_types (name, code, kind, is_paid, allow_half_day, sort_order)
SELECT 'Earned leave', 'EL', 'leave', 1, 0, 30
 WHERE NOT EXISTS (SELECT 1 FROM hr_leave_types WHERE code = 'EL');
INSERT INTO hr_leave_types (name, code, kind, is_paid, allow_half_day, sort_order)
SELECT 'Unpaid leave', 'LWP', 'leave', 0, 1, 40
 WHERE NOT EXISTS (SELECT 1 FROM hr_leave_types WHERE code = 'LWP');
INSERT INTO hr_leave_types (name, code, kind, is_paid, allow_half_day, sort_order)
SELECT 'Work from home', 'WFH', 'wfh', 1, 0, 50
 WHERE NOT EXISTS (SELECT 1 FROM hr_leave_types WHERE code = 'WFH');
INSERT INTO hr_leave_types (name, code, kind, is_paid, allow_half_day, sort_order)
SELECT 'Field work', 'FIELD', 'field', 1, 0, 60
 WHERE NOT EXISTS (SELECT 1 FROM hr_leave_types WHERE code = 'FIELD');

-- =============================================================================
-- Attendance exceptions: missing punches and suspicious punches
-- =============================================================================
--
-- `auto_closed` marks a session the SYSTEM ended because its owner never checked
-- out and the day has passed. It is closed at its own start (zero minutes), not
-- at the shift end: crediting eight hours nobody recorded would be inventing a
-- number. The day is flagged as a missing punch and the employee corrects it
-- with a regularisation, which replaces the sessions.
--
-- `in_flags` / `out_flags` record what looked wrong about a punch at the moment
-- it was made. Recorded, never used to refuse — the requirement is to flag for
-- review, and a false positive that blocked an honest check-in would cost more
-- than the cheat it caught.
--
--   mock_location — the handset reported the fix came from a mock provider
--   clock_skew    — the handset clock was more than ten minutes from the server
--   low_accuracy  — the reported accuracy was too coarse to judge a geofence
ALTER TABLE hr_attendance_sessions
  ADD COLUMN auto_closed TINYINT(1) NOT NULL DEFAULT 0 AFTER source,
  ADD COLUMN in_flags  SET('mock_location','clock_skew','low_accuracy') NOT NULL DEFAULT '' AFTER auto_closed,
  ADD COLUMN out_flags SET('mock_location','clock_skew','low_accuracy') NOT NULL DEFAULT '' AFTER in_flags;

-- Corrections can now be decided by a team manager in the app as well as by an
-- administrator, so the reviewer id needs to say which id space it is in — the
-- same pair of columns hr_leave_requests carries.
ALTER TABLE hr_regularisations
  ADD COLUMN reviewer_type ENUM('admin','manager') NULL AFTER reviewed_by,
  ADD COLUMN reviewer_name VARCHAR(120) NULL AFTER reviewer_type;

-- Day-level roll-ups of the above, recomputed with the rest of the day so the
-- register and the review queue are single-table reads.
ALTER TABLE hr_attendance
  ADD COLUMN missing_punch    TINYINT(1)      NOT NULL DEFAULT 0 AFTER note,
  ADD COLUMN flagged          TINYINT(1)      NOT NULL DEFAULT 0 AFTER missing_punch,
  ADD COLUMN flag_reviewed_by BIGINT UNSIGNED NULL AFTER flagged,
  ADD COLUMN flag_reviewed_at DATETIME        NULL AFTER flag_reviewed_by,
  ADD COLUMN flag_review_note VARCHAR(500)    NULL AFTER flag_reviewed_at,
  ADD INDEX idx_hr_attendance_flagged (flagged, work_date),
  ADD INDEX idx_hr_attendance_missing (missing_punch, work_date);
