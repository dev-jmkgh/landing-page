-- =============================================================================
-- 018 — HR attendance: work locations, shifts, punches and regularisation
--
-- The attendance module, whole: check in and out against a geofenced site, a
-- daily history with working hours and breaks, lateness measured against a
-- shift, and a request to correct a missing punch.
--
-- EVERYTHING HERE IS HR'S OWN. Not one table references `telecaller_users`, for
-- the reason set out in 017: the two products must not be able to reach each
-- other's accounts. An employee's attendance belongs to their HR account.
--
-- THREE RULES THIS SCHEMA EXISTS TO ENFORCE
--
--   1. The SERVER owns the time. Every timestamp here is written by MySQL's
--      NOW(), never by a value the handset sent. A phone's clock is user
--      settable, and attendance drives pay — a client-supplied punch time is a
--      self-service pay rise. The handset's own clock is recorded separately,
--      in `*_device_at`, purely so a large skew can be investigated.
--
--   2. The SERVER decides the geofence. The app sends coordinates; the distance
--      and the accept/refuse decision are computed here. A client that decided
--      would be bypassed by anyone who could edit a JSON body.
--
--   3. A day is a ROW, not a pair of events. One row per employee per date,
--      with a unique key enforcing it. Modelling punches as an event log reads
--      well until two check-ins race and the day has two open punches with no
--      way to say which is real.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Work locations — a site, and the circle around it
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_work_locations (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(120)    NOT NULL,
  address        VARCHAR(400)    NULL,

  -- DECIMAL, not DOUBLE.
  --
  -- A float cannot hold a decimal coordinate exactly, and a geofence is a
  -- comparison against a boundary — the one place a half-metre of rounding
  -- decides whether somebody is marked absent. DECIMAL(10,7) resolves to about
  -- 1.1cm, far finer than any handset's GPS.
  latitude       DECIMAL(10,7)   NOT NULL,
  longitude      DECIMAL(10,7)   NOT NULL,

  -- How far from that point still counts as "at work".
  --
  -- Defaults to 150m, which sounds generous and is not: a consumer GPS fix is
  -- routinely 20–50m out, worse indoors and worse again in a built-up area. Too
  -- tight a radius does not catch cheats, it refuses honest people standing in
  -- their own office, and the support cost of that lands on HR every morning.
  radius_metres  SMALLINT UNSIGNED NOT NULL DEFAULT 150,

  is_active      TINYINT(1)      NOT NULL DEFAULT 1,
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_work_locations_name (name),
  KEY idx_hr_work_locations_active (is_active, name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Shifts — the working pattern lateness is measured against
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_shifts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120)    NOT NULL,

  starts_at       TIME            NOT NULL,
  ends_at         TIME            NOT NULL,

  -- Unpaid break deducted from the working total, in minutes. A flat number
  -- rather than a schedule: tracked break punches live in hr_attendance_breaks
  -- and take precedence when present, and this is the fallback for a day where
  -- nobody punched a break.
  break_minutes   SMALLINT UNSIGNED NOT NULL DEFAULT 60,

  -- Minutes after `starts_at` that are still not "late".
  --
  -- Exists because without it the flag is noise: a shift starting at 09:00
  -- marks 09:00:31 late, every commuter is late most days, and a report nobody
  -- believes is a report nobody reads.
  grace_minutes   SMALLINT UNSIGNED NOT NULL DEFAULT 10,

  -- Below this, a present day is recorded as a half day.
  half_day_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 240,

  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_shifts_name (name),
  KEY idx_hr_shifts_active (is_active, name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Assignment: which site, which shift, which way of working
-- -----------------------------------------------------------------------------
ALTER TABLE hr_users
  -- NULL means "not assigned yet", and the check-in service treats that as a
  -- refusal with an explanation rather than as "no geofence". Defaulting an
  -- unassigned employee to unrestricted would make forgetting to assign
  -- somebody invisible, which is the failure that matters here.
  ADD COLUMN work_location_id BIGINT UNSIGNED NULL AFTER role,
  ADD COLUMN shift_id         BIGINT UNSIGNED NULL AFTER work_location_id,

  -- How this person works, which decides whether the geofence applies.
  --
  --   office — must be inside the radius of their assigned site.
  --   remote — works from home; coordinates are recorded, never enforced.
  --   field  — out visiting; coordinates recorded, never enforced.
  --
  -- Recorded-but-not-enforced is deliberate for the latter two: HR can still
  -- see where a punch came from, which is the honest middle ground between
  -- pretending to control it and knowing nothing at all.
  ADD COLUMN work_mode        ENUM('office','remote','field') NOT NULL DEFAULT 'office' AFTER shift_id,

  ADD CONSTRAINT fk_hr_users_work_location
    FOREIGN KEY (work_location_id) REFERENCES hr_work_locations (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_hr_users_shift
    FOREIGN KEY (shift_id) REFERENCES hr_shifts (id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- Attendance — one row per employee per day
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_attendance (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,

  -- The day this belongs to, in the company's timezone.
  --
  -- Stored rather than derived from `checked_in_at`, because the two diverge the
  -- moment a shift crosses midnight and because every history query groups by
  -- it. A DATE also makes the unique key below possible, which is what stops a
  -- double check-in creating a second day.
  work_date         DATE            NOT NULL,

  /* ---- check in ---- */
  checked_in_at     DATETIME        NULL,
  -- What the HANDSET believed the time was. Never used in any calculation;
  -- kept so a dispute can be shown a clock that was two hours out.
  check_in_device_at DATETIME       NULL,
  check_in_lat      DECIMAL(10,7)   NULL,
  check_in_lng      DECIMAL(10,7)   NULL,
  -- Metres from the assigned site at the moment of the punch, as the server
  -- computed it. Stored, not recomputed later: the employee's assigned site can
  -- change, and a distance that silently re-evaluates is not evidence.
  check_in_distance_metres INT UNSIGNED NULL,
  -- The handset's own accuracy estimate. A punch 200m out with a 500m accuracy
  -- radius is a bad fix, not a person in the wrong place.
  check_in_accuracy_metres INT UNSIGNED NULL,
  check_in_location_id BIGINT UNSIGNED NULL,

  /* ---- check out ---- */
  checked_out_at    DATETIME        NULL,
  check_out_device_at DATETIME      NULL,
  check_out_lat     DECIMAL(10,7)   NULL,
  check_out_lng     DECIMAL(10,7)   NULL,
  check_out_distance_metres INT UNSIGNED NULL,
  check_out_accuracy_metres INT UNSIGNED NULL,

  /* ---- what it added up to ---- */

  -- Minutes between the punches, LESS break time. Written at checkout and on
  -- any later correction; NULL while the day is still open, which is what
  -- distinguishes "still working" from "worked nothing".
  worked_minutes    INT UNSIGNED    NULL,
  break_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  late_minutes      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  early_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- 'present'   — in, and either still working or out again.
  -- 'late'      — in, after the grace period.
  -- 'half_day'  — out, having worked less than the shift's half-day threshold.
  -- 'absent'    — a day with no punch, written by the backfill, never by the app.
  -- 'on_leave'  — reserved for the leave module; nothing writes it yet.
  status            ENUM('present','late','half_day','absent','on_leave')
                      NOT NULL DEFAULT 'present',

  -- Snapshots, taken at check-in and never updated.
  --
  -- A shift's start time and an employee's work mode both change, and when they
  -- do, every historical lateness figure derived from the LIVE row would move
  -- with them. A rota change in March must not make somebody retrospectively
  -- late in January.
  shift_id          BIGINT UNSIGNED NULL,
  shift_starts_at   TIME            NULL,
  shift_ends_at     TIME            NULL,
  work_mode         ENUM('office','remote','field') NOT NULL DEFAULT 'office',

  -- Where this row came from. 'app' is a real punch; the others are corrections
  -- and must be distinguishable from one forever.
  source            ENUM('app','regularisation','admin') NOT NULL DEFAULT 'app',
  note              VARCHAR(500)    NULL,

  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- THE RULE THAT MAKES THE REST SAFE.
  --
  -- One row per person per day, enforced by the database rather than by a
  -- read-then-write in the service. Two check-ins arriving together — a retry,
  -- a double tap, a queued offline punch replayed — race, and the loser gets a
  -- duplicate-key error the service turns into "you are already checked in"
  -- rather than a second row nobody can reconcile.
  UNIQUE KEY uq_hr_attendance_day (user_id, work_date),

  KEY idx_hr_attendance_date (work_date),
  KEY idx_hr_attendance_user_date (user_id, work_date),
  KEY idx_hr_attendance_status (status, work_date),

  CONSTRAINT fk_hr_attendance_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: deleting a site must not delete the attendance
  -- recorded at it.
  CONSTRAINT fk_hr_attendance_location
    FOREIGN KEY (check_in_location_id) REFERENCES hr_work_locations (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Breaks — punched, not assumed
-- -----------------------------------------------------------------------------
--
-- A separate table because a day has any number of breaks, and because an open
-- break (ended_at IS NULL) is a state the UI has to render. Rolling it into
-- hr_attendance would mean a pair of columns per break, capped at however many
-- somebody guessed.
CREATE TABLE IF NOT EXISTS hr_attendance_breaks (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  attendance_id BIGINT UNSIGNED NOT NULL,
  started_at    DATETIME        NOT NULL,
  ended_at      DATETIME        NULL,
  minutes       SMALLINT UNSIGNED NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_hr_breaks_attendance (attendance_id, started_at),
  CONSTRAINT fk_hr_breaks_attendance
    FOREIGN KEY (attendance_id) REFERENCES hr_attendance (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Regularisation — asking for a missing punch to be corrected
-- -----------------------------------------------------------------------------
--
-- Its own table rather than an edit to hr_attendance, because the REQUEST has a
-- life of its own: it is raised, it waits, it is approved or refused with a
-- reason, and all of that has to survive the attendance row being corrected.
-- Writing the correction straight onto the day would leave no record that
-- anybody asked.
CREATE TABLE IF NOT EXISTS hr_regularisations (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  work_date      DATE            NOT NULL,

  -- What the employee says the punches should have been. Either may be NULL —
  -- a forgotten check-out is the common case and only needs one of them.
  requested_check_in_at  DATETIME NULL,
  requested_check_out_at DATETIME NULL,

  -- Required. A correction with no stated reason is one an approver cannot
  -- judge, and this is the only place the employee gets to explain.
  reason         VARCHAR(500)    NOT NULL,

  status         ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',

  -- An admin_users id. Deliberately not a foreign key: a decision is an audit
  -- record and must outlive the reviewer's account.
  reviewed_by    BIGINT UNSIGNED NULL,
  reviewed_at    DATETIME        NULL,
  review_note    VARCHAR(500)    NULL,

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One OPEN request per person per day.
  --
  -- A partial index is not available in MySQL, so this is enforced in the
  -- service instead; the index below is what makes that check cheap. A unique
  -- key on (user_id, work_date) alone would be wrong — a rejected request must
  -- not block a corrected resubmission.
  KEY idx_hr_regularisations_open (user_id, work_date, status),
  KEY idx_hr_regularisations_queue (status, created_at),

  CONSTRAINT fk_hr_regularisations_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- A starting shift, so the module is usable the moment it deploys
-- -----------------------------------------------------------------------------
--
-- Deliberately NOT a work location. A shift's 09:00–18:00 is a safe, editable
-- guess; a site's coordinates are not something this migration can invent, and
-- a made-up geofence would refuse every real employee at a real office. HR
-- creates sites in the admin portal with their own coordinates.
INSERT INTO hr_shifts (name, starts_at, ends_at, break_minutes, grace_minutes)
SELECT 'General shift', '09:00:00', '18:00:00', 60, 10
 WHERE NOT EXISTS (SELECT 1 FROM hr_shifts WHERE name = 'General shift');
