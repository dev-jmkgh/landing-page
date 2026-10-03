-- =============================================================================
-- 017 — The HR app gets its own accounts
--
-- WHY A SECOND ACCOUNT TABLE RATHER THAN A ROLE ON telecaller_users.
--
-- Migration 016 added an 'employee' role so HR staff could register through the
-- telecalling signup. That was wrong, and this migration takes it back out.
--
-- The two apps serve overlapping PEOPLE. A telecaller is also an employee: they
-- take leave, they have payslips, they need the HR app. But `telecaller_users`
-- has a UNIQUE index on `email`, so one address is one row — meaning that
-- person could hold an account in one app or the other, never both. The first
-- telecaller to try registering in the HR app would be told their address was
-- already taken, with no way forward.
--
-- Sharing the row does not fix it either, it just hides the coupling somewhere
-- worse. These columns are all single-valued and all load-bearing in BOTH apps:
--
--   password_hash    — changing it in HR would change the telecalling password.
--   is_active        — an HR offboarding would silently revoke lead access.
--   approval_status  — one approval queue deciding access to two products.
--   last_login_at    — no longer answers "when did they last work a lead?".
--
-- So: two tables, one per product, and a person who needs both has a row in
-- each. That is the same reasoning migration 005 used to keep `telecaller_users`
-- apart from `admin_users`, applied again for the same reason.
--
-- The duplication is real but small (a name, an address, a phone number, a
-- password) and it buys genuine independence: nothing the HR app does can touch
-- a telecalling account, because it cannot see one.
--
-- The two are kept apart at the token layer as well — HR access tokens carry
-- audience 'jmk-hr' and the telecalling API only accepts 'jmk-mobile', so an HR
-- token is not merely unprivileged on a lead endpoint, it is unreadable there.
-- =============================================================================

CREATE TABLE IF NOT EXISTS hr_users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Its OWN series, EMP-0001 upward, counted independently of TC- codes. The
  -- same human can hold TC-0007 and EMP-0003 at once; the codes identify an
  -- account in a product, not a person.
  employee_code     VARCHAR(24)     NOT NULL,

  name              VARCHAR(120)    NOT NULL,
  email             VARCHAR(190)    NOT NULL,

  -- NULL until the applicant has entered the code emailed to them. Fail-closed,
  -- for the reasons spelled out in 011.
  email_verified_at DATETIME        NULL,

  phone             VARCHAR(20)     NULL,
  password_hash     VARCHAR(255)    NOT NULL,

  -- Deliberately NOT the telecalling role set. Nothing here grants anything in
  -- the telecalling product, and the two enums must stay free to diverge.
  --
  -- 'employee'   — ordinary staff: their own attendance, leave and payslips.
  -- 'hr_manager' — reviews and approves other people's requests.
  -- 'hr_admin'   — runs the HR function.
  role              ENUM('employee','hr_manager','hr_admin') NOT NULL DEFAULT 'employee',

  -- Defaults to 0, so a row created by an INSERT that forgets these columns is
  -- unusable rather than live. Same fail-closed shape as migration 010.
  is_active         TINYINT(1)      NOT NULL DEFAULT 0,
  approval_status   ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',

  registered_at     DATETIME        NULL,

  -- An admin_users id. Intentionally NOT a foreign key: approvals are an audit
  -- trail and must survive the reviewer's account being deleted.
  approved_by       BIGINT UNSIGNED NULL,
  approved_at       DATETIME        NULL,
  rejection_reason  VARCHAR(500)    NULL,

  last_login_at     DATETIME        NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_users_email (email),
  UNIQUE KEY uq_hr_users_code (employee_code),
  -- The approvals queue: pending first, oldest first.
  KEY idx_hr_users_approval (approval_status, registered_at),
  KEY idx_hr_users_active_name (is_active, name)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Refresh sessions, one row per signed-in HR device
-- -----------------------------------------------------------------------------
--
-- Not reusing `mobile_sessions`: its user_id has a foreign key onto
-- telecaller_users, so an HR row could not exist in it without either dropping
-- that constraint or pointing at the wrong table. Both are worse than a second
-- table with the same shape.
--
-- Only the SHA-256 of the refresh token is stored, for the reason given in 005.
CREATE TABLE IF NOT EXISTS hr_sessions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id            BIGINT UNSIGNED NOT NULL,
  refresh_token_hash CHAR(64)        NOT NULL,
  device_name        VARCHAR(120)    NULL,
  device_platform    ENUM('android','ios','unknown') NOT NULL DEFAULT 'unknown',
  push_token         VARCHAR(255)    NULL,
  expires_at         DATETIME        NOT NULL,
  revoked_at         DATETIME        NULL,
  last_used_at       DATETIME        NULL,
  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_sessions_token (refresh_token_hash),
  KEY idx_hr_sessions_user (user_id, revoked_at),
  KEY idx_hr_sessions_expiry (expires_at),
  CONSTRAINT fk_hr_sessions_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Email verification codes
-- -----------------------------------------------------------------------------
--
-- Same shape and the same reasoning as `employee_email_otps` in 011 — separate
-- only because its foreign key points at hr_users.
CREATE TABLE IF NOT EXISTS hr_email_otps (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  code_hash   CHAR(64)        NOT NULL,
  expires_at  DATETIME        NOT NULL,
  consumed_at DATETIME        NULL,
  attempts    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_hr_email_otps_user (user_id, expires_at),
  CONSTRAINT fk_hr_email_otps_user FOREIGN KEY (user_id)
    REFERENCES hr_users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- =============================================================================
-- Undo 016: the 'employee' role leaves telecaller_users
-- =============================================================================
--
-- HR registration no longer goes through the telecalling signup, so the role it
-- was added for has no remaining user. Leaving it would be dead surface that
-- invites exactly the coupling the tables above exist to prevent.
--
-- Rows are DEMOTED rather than deleted. The ALTER below would otherwise either
-- fail or silently coerce them to the first enum member ('admin'), which is the
-- worst possible outcome. Only accounts created by 016's short-lived HR signup
-- can be in this state: created inactive and pending, never able to sign in. A
-- demoted row is still pending, so it still cannot sign in, and an administrator
-- can delete it at leisure.
UPDATE telecaller_users
   SET role = 'telecaller'
 WHERE role = 'employee';

ALTER TABLE telecaller_users
  MODIFY COLUMN role
    ENUM('admin','manager','supervisor','telecaller')
    NOT NULL DEFAULT 'telecaller';
