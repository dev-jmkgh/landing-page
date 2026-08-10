-- =============================================================================
-- 002 — Career applications
-- Resume files are stored on disk outside the web root; only metadata lives here.
-- =============================================================================

CREATE TABLE IF NOT EXISTS job_applications (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference             VARCHAR(16)     NOT NULL,
  full_name             VARCHAR(120)    NOT NULL,
  email                 VARCHAR(190)    NOT NULL,
  phone                 VARCHAR(20)     NOT NULL,
  position              VARCHAR(120)    NOT NULL,
  message               TEXT            NULL,
  -- Randomised name on disk; never the name supplied by the applicant.
  resume_filename       VARCHAR(255)    NULL,
  resume_original_name  VARCHAR(255)    NULL,
  resume_mime           VARCHAR(120)    NULL,
  resume_size           INT UNSIGNED    NULL,
  status                ENUM('new','contacted','in_progress','closed') NOT NULL DEFAULT 'new',
  ip_address            VARCHAR(45)     NULL,
  user_agent            VARCHAR(255)    NULL,
  notification_sent     TINYINT(1)      NOT NULL DEFAULT 0,
  autoreply_sent        TINYINT(1)      NOT NULL DEFAULT 0,
  created_at            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_applications_reference (reference),
  KEY idx_applications_status_created (status, created_at),
  KEY idx_applications_created (created_at),
  KEY idx_applications_position (position),
  KEY idx_applications_email (email)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
