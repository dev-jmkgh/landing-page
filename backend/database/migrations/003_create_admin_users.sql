-- =============================================================================
-- 003 — Admin users
-- Passwords are stored only as bcrypt hashes. Create the first user with:
--   npm run hash:password -- "YourStrongPassword"
-- then either seed the row (npm run db:seed) or set ADMIN_EMAIL /
-- ADMIN_PASSWORD_HASH in the environment.
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(190)    NOT NULL,
  password_hash VARCHAR(255)    NOT NULL,
  name          VARCHAR(120)    NULL,
  is_active     TINYINT(1)      NOT NULL DEFAULT 1,
  last_login_at DATETIME        NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_users_email (email)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
