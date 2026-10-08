-- =============================================================================
-- 019 — Attendance becomes many sessions a day, not one pair
--
-- 018 modelled a day as a single check-in and check-out, with punched breaks in
-- between. Real days do not look like that:
--
--   09:00 in · 13:00 out · 14:00 in · 18:00 out
--
-- That is two working sessions, not one day with a break. The distinction is not
-- cosmetic: with a single pair, the 13:00 check-out CLOSES the day, and the
-- 14:00 check-in has nowhere to go.
--
-- WHY BREAKS GO AWAY
--
-- `hr_attendance_breaks` is retired rather than kept in use. With sessions, a
-- break IS the gap between one ending and the next beginning — so recording both
-- would give an employee two different ways to record the same hour, and the two
-- could disagree. The break total is now DERIVED from the gaps, so nothing is
-- lost from the day summary; only the second button is gone.
--
-- The table itself is LEFT IN PLACE, unused. Migrations run as the application's
-- own database user, and in production that user has no DROP privilege (the first
-- revision of this file ended with a DROP TABLE and failed there). No code reads or
-- writes the table any more, and a database administrator may drop it by hand.
--
-- WHAT hr_attendance STILL DOES
--
-- It stays, as the DAY ROLL-UP, because almost everything reads days rather than
-- punches — the register, the history list, the monthly summary, lateness, the
-- status. Its columns change meaning rather than disappearing:
--
--   checked_in_at   — the FIRST check-in of the day
--   checked_out_at  — the LAST check-out, NULL while any session is open
--   worked_minutes  — the SUM of completed sessions
--   break_minutes   — the total gap BETWEEN sessions, derived
--
-- Recomputing the roll-up on every punch rather than deriving it on read keeps
-- the register and the month summary as the single-table scans they already are.
-- =============================================================================

CREATE TABLE IF NOT EXISTS hr_attendance_sessions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  attendance_id   BIGINT UNSIGNED NOT NULL,

  -- Denormalised from `hr_attendance`, and immutable once written.
  --
  -- "Which session is this person currently in?" is the hottest query in the
  -- module — every open of the attendance screen runs it — and carrying the id
  -- here answers it without a join. It is also what makes the unique index
  -- below possible.
  user_id         BIGINT UNSIGNED NOT NULL,

  started_at      DATETIME        NOT NULL,
  -- NULL means the session is still running. That is the app's entire notion of
  -- "checked in", and the index below depends on it staying meaningful.
  ended_at        DATETIME        NULL,

  -- Written when the session closes. NULL while open, so "still working" is
  -- distinguishable from "worked nothing".
  minutes         INT UNSIGNED    NULL,

  /* ---- where and when the punches happened ---- */
  in_device_at    DATETIME        NULL,
  in_lat          DECIMAL(10,7)   NULL,
  in_lng          DECIMAL(10,7)   NULL,
  in_distance_metres INT UNSIGNED NULL,
  in_accuracy_metres INT UNSIGNED NULL,
  in_location_id  BIGINT UNSIGNED NULL,

  out_device_at   DATETIME        NULL,
  out_lat         DECIMAL(10,7)   NULL,
  out_lng         DECIMAL(10,7)   NULL,
  out_distance_metres INT UNSIGNED NULL,
  out_accuracy_metres INT UNSIGNED NULL,

  source          ENUM('app','regularisation','admin') NOT NULL DEFAULT 'app',

  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- ONE OPEN SESSION PER PERSON, enforced by the database.
  --
  -- MySQL has no partial index, so this is the standard substitute: a stored
  -- generated column that holds the user id only while the session is open, and
  -- NULL once it closes. A UNIQUE index ignores NULLs, so any number of CLOSED
  -- sessions coexist while a second OPEN one is rejected outright.
  --
  -- This replaces the `(user_id, work_date)` key from 018 as the thing that makes
  -- a double check-in impossible. It has to be the database and not the service:
  -- two taps, a retry and a replayed offline punch all race, and a read-then-write
  -- check loses that race silently.
  open_marker     BIGINT UNSIGNED
                    GENERATED ALWAYS AS (IF(ended_at IS NULL, user_id, NULL)) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_att_sessions_one_open (open_marker),
  KEY idx_hr_att_sessions_day (attendance_id, started_at),
  KEY idx_hr_att_sessions_user (user_id, started_at),

  -- Prefixed `hr_att_` rather than `hr_`: foreign key names are GLOBAL to the
  -- database in MySQL, and migration 017 already used `fk_hr_sessions_user` for
  -- the refresh-token table. The collision fails the migration outright.
  CONSTRAINT fk_hr_att_sessions_attendance
    FOREIGN KEY (attendance_id) REFERENCES hr_attendance (id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: removing a site must not delete the attendance taken at it.
  CONSTRAINT fk_hr_att_sessions_location
    FOREIGN KEY (in_location_id) REFERENCES hr_work_locations (id) ON DELETE SET NULL

  -- THERE IS DELIBERATELY NO FOREIGN KEY ON `user_id`.
  --
  -- MySQL refuses one: `user_id` is the base column of the stored generated
  -- column `open_marker`, and a foreign key on such a column may not use
  -- CASCADE, SET NULL or SET DEFAULT. The error it gives is the unhelpful
  -- "Cannot add foreign key constraint".
  --
  -- Nothing is lost. Deleting an `hr_users` row cascades to `hr_attendance`,
  -- which cascades here through `fk_hr_att_sessions_attendance` — so sessions
  -- still cannot outlive their employee. `user_id` is written once from the
  -- parent row and never updated, so it cannot drift out of step with it.
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Backfill: every existing day becomes its single session
-- -----------------------------------------------------------------------------
--
-- Without this, days recorded under 018 would show a total with no sessions
-- behind it, and the new history screen would render them as empty.
--
-- `minutes` is recomputed from the pair rather than copied from
-- `worked_minutes`, because that column already had the old break deduction
-- applied — carrying it across would subtract the break twice once the roll-up
-- below recomputes from the gaps.
INSERT INTO hr_attendance_sessions
  (attendance_id, user_id, started_at, ended_at, minutes,
   in_device_at, in_lat, in_lng, in_distance_metres, in_accuracy_metres, in_location_id,
   out_device_at, out_lat, out_lng, out_distance_metres, out_accuracy_metres, source)
SELECT a.id, a.user_id, a.checked_in_at, a.checked_out_at,
       CASE WHEN a.checked_out_at IS NULL THEN NULL
            ELSE GREATEST(0, TIMESTAMPDIFF(MINUTE, a.checked_in_at, a.checked_out_at))
       END,
       a.check_in_device_at, a.check_in_lat, a.check_in_lng,
       a.check_in_distance_metres, a.check_in_accuracy_metres, a.check_in_location_id,
       a.check_out_device_at, a.check_out_lat, a.check_out_lng,
       a.check_out_distance_metres, a.check_out_accuracy_metres,
       a.source
  FROM hr_attendance a
 WHERE a.checked_in_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM hr_attendance_sessions s WHERE s.attendance_id = a.id);

-- Re-derive the roll-up for the backfilled days. A single session has no gaps, so
-- its break total is zero and its worked total is the pair — which undoes 018's
-- punched-break deduction on exactly the rows that had one.
UPDATE hr_attendance a
   SET a.break_minutes = 0,
       a.worked_minutes = (
         SELECT SUM(s.minutes) FROM hr_attendance_sessions s
          WHERE s.attendance_id = a.id AND s.ended_at IS NOT NULL
       )
 WHERE a.checked_in_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- The break table is superseded
-- -----------------------------------------------------------------------------
--
-- Deliberately not dropped (see the header): the application's database user
-- cannot DROP. Every statement above is safe to run again, so a database where
-- the first revision stopped at its DROP finishes this file cleanly.
