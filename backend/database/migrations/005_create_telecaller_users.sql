-- =============================================================================
-- 005 — Telecalling employees and their mobile sessions
--
-- Deliberately a separate table from `admin_users`. That table exists to let one
-- or two operators read website enquiries; this one carries an org chart, roles,
-- availability and lead ownership, and it is the identity the mobile app signs
-- in with. Merging them would mean every website admin becomes a telecaller with
-- an empty lead list, and every telecaller gains access to career applications.
--
-- Both tables can coexist: an operator who needs both simply has a row in each.
-- Create the first telecalling admin with:
--   npm run hash:password -- "YourStrongPassword"
-- then insert a row with role = 'admin'.
-- =============================================================================

CREATE TABLE IF NOT EXISTS telecaller_users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Human-facing identifier printed on reports and spoken aloud in a standup,
  -- e.g. TC-0007. Never the primary key: staff codes get reissued and renamed.
  employee_code VARCHAR(24)     NOT NULL,
  name          VARCHAR(120)    NOT NULL,
  email         VARCHAR(190)    NOT NULL,
  phone         VARCHAR(20)     NULL,
  password_hash VARCHAR(255)    NOT NULL,
  role          ENUM('admin','manager','supervisor','telecaller') NOT NULL DEFAULT 'telecaller',
  -- Set by the employee from the mobile app. Purely informational: it does not
  -- gate anything, because a telecaller who forgets to flip it back to
  -- 'available' must not silently stop receiving leads.
  availability  ENUM('available','busy','on_break','offline') NOT NULL DEFAULT 'offline',
  is_active     TINYINT(1)      NOT NULL DEFAULT 1,
  last_login_at DATETIME        NULL,
  -- Who added this employee. Nullable because the first admin is seeded.
  created_by    BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_telecaller_users_email (email),
  UNIQUE KEY uq_telecaller_users_code (employee_code),
  -- Employee pickers and the assignment screen both ask for active telecallers.
  KEY idx_telecaller_users_role_active (role, is_active),
  KEY idx_telecaller_users_active_name (is_active, name)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- =============================================================================
-- Mobile refresh sessions
--
-- The mobile app cannot use the cookie session the admin web app uses, so it
-- holds a short-lived access JWT plus one row here per signed-in device.
--
-- Only the SHA-256 of the refresh token is stored. A dump of this table
-- therefore cannot be used to mint sessions — the same reasoning that keeps
-- plaintext passwords out of `password_hash`.
-- =============================================================================

CREATE TABLE IF NOT EXISTS mobile_sessions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id            BIGINT UNSIGNED NOT NULL,
  refresh_token_hash CHAR(64)        NOT NULL,
  device_name        VARCHAR(120)    NULL,
  device_platform    ENUM('android','ios','unknown') NOT NULL DEFAULT 'unknown',
  -- Expo push token for this specific device. Cleared on sign-out so a
  -- reassigned handset does not keep receiving the previous employee's leads.
  push_token         VARCHAR(255)    NULL,
  expires_at         DATETIME        NOT NULL,
  revoked_at         DATETIME        NULL,
  last_used_at       DATETIME        NULL,
  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_mobile_sessions_token (refresh_token_hash),
  -- "Every live session for this employee" — needed on sign-out-everywhere and
  -- when an admin deactivates an account mid-shift.
  KEY idx_mobile_sessions_user (user_id, revoked_at),
  KEY idx_mobile_sessions_expiry (expires_at),
  CONSTRAINT fk_mobile_sessions_user
    FOREIGN KEY (user_id) REFERENCES telecaller_users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
