-- =============================================================================
-- 027 — The employee record: organisation, employment and personal details
--
-- Until now an HR account was a sign-in and an assignment. This is the rest of
-- what HR keeps about a person, so the admin portal can manage employees rather
-- than registrations, and the app can show an employee their own record:
--
--   * departments and designations, as managed lists rather than free text, so
--     a report can group by them without "Sales", "sales" and "Sales team"
--     becoming three departments
--   * the reporting line (manager_id), which is what lets a team manager see
--     and approve their own team in the app
--   * employment facts: joining date, employment type and status
--   * the personal details an employee may ask HR to change
--
-- Everything is NULLABLE and added to the existing hr_users table. An account
-- created before this migration has none of these facts recorded, and the app
-- says so rather than filling them from something adjacent (see the HR app
-- README on why `created_at` is not a joining date).
--
-- Like every HR migration: nothing here references telecalling tables.
-- =============================================================================

CREATE TABLE IF NOT EXISTS hr_departments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120)    NOT NULL,
  -- Short code for reports and exports, e.g. FIN. Optional.
  code        VARCHAR(24)     NULL,
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_departments_name (name),
  KEY idx_hr_departments_active (is_active, name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hr_designations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120)    NOT NULL,
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_designations_name (name),
  KEY idx_hr_designations_active (is_active, name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

ALTER TABLE hr_users
  ADD COLUMN department_id  BIGINT UNSIGNED NULL AFTER work_mode,
  ADD COLUMN designation_id BIGINT UNSIGNED NULL AFTER department_id,

  -- Another hr_users row: the person who approves this one's leave and
  -- corrections in the app. NULL means HR in the admin portal decides alone.
  -- The service refuses a cycle (A manages B manages A), which the database
  -- cannot express.
  ADD COLUMN manager_id     BIGINT UNSIGNED NULL AFTER designation_id,

  -- The employment fact, entered by HR. NOT derived from registered_at or
  -- created_at, which are when a database row appeared.
  ADD COLUMN joining_date   DATE NULL AFTER manager_id,

  -- Last working day, set when someone leaves. Payroll stops paying after it.
  ADD COLUMN exit_date      DATE NULL AFTER joining_date,

  ADD COLUMN employment_type   ENUM('full_time','part_time','contract','intern')
                               NOT NULL DEFAULT 'full_time' AFTER exit_date,

  -- The employment relationship, independent of whether the account may sign
  -- in (is_active). Someone serving notice still signs in; someone exited is
  -- normally deactivated too, but the two are different facts and HR sets both.
  ADD COLUMN employment_status ENUM('probation','active','notice_period','exited')
                               NOT NULL DEFAULT 'active' AFTER employment_type,

  -- Personal details. The employee cannot edit these directly: they raise a
  -- profile-update request and HR applies it (migration 029), so a change to
  -- an emergency contact always has a record of who asked and who agreed.
  ADD COLUMN date_of_birth           DATE         NULL AFTER employment_status,
  ADD COLUMN address                 VARCHAR(400) NULL AFTER date_of_birth,
  ADD COLUMN emergency_contact_name  VARCHAR(120) NULL AFTER address,
  ADD COLUMN emergency_contact_phone VARCHAR(20)  NULL AFTER emergency_contact_name,

  ADD CONSTRAINT fk_hr_users_department
    FOREIGN KEY (department_id) REFERENCES hr_departments (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_hr_users_designation
    FOREIGN KEY (designation_id) REFERENCES hr_designations (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_hr_users_manager
    FOREIGN KEY (manager_id) REFERENCES hr_users (id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- HR settings — a handful of company-wide policy values
-- -----------------------------------------------------------------------------
--
-- Key/value rather than a column per setting, because each one arrives with the
-- feature that needs it and a schema change per policy knob is churn. Values are
-- strings, parsed and validated by the service that owns the key.
--
--   attendance_tracked_from  DATE. Days before it are not judged present or
--                            absent by payroll: the system did not exist yet,
--                            so "no punch" means nothing. NULL judges every day.
--   default_weekly_off       Weekly-off days for an employee with no shift,
--                            as a comma list of sun..sat. 'sun' when unset.
CREATE TABLE IF NOT EXISTS hr_settings (
  setting_key   VARCHAR(64)  NOT NULL,
  setting_value VARCHAR(500) NULL,
  updated_by    BIGINT UNSIGNED NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (setting_key)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
