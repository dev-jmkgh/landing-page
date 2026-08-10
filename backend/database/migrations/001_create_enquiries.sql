-- =============================================================================
-- 001 — Enquiries
-- Stores submissions from the floating enquiry widget and the contact page.
-- =============================================================================

CREATE TABLE IF NOT EXISTS enquiries (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference         VARCHAR(16)     NOT NULL,
  name              VARCHAR(120)    NOT NULL,
  email             VARCHAR(190)    NOT NULL,
  phone             VARCHAR(20)     NOT NULL,
  company           VARCHAR(150)    NULL,
  interested_in     VARCHAR(60)     NOT NULL,
  message           TEXT            NOT NULL,
  source            VARCHAR(30)     NOT NULL DEFAULT 'floating-widget',
  status            ENUM('new','contacted','in_progress','closed') NOT NULL DEFAULT 'new',
  ip_address        VARCHAR(45)     NULL,
  user_agent        VARCHAR(255)    NULL,
  notification_sent TINYINT(1)      NOT NULL DEFAULT 0,
  autoreply_sent    TINYINT(1)      NOT NULL DEFAULT 0,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_enquiries_reference (reference),
  -- Admin list view: filter by status, newest first.
  KEY idx_enquiries_status_created (status, created_at),
  -- Default list view and date-range reporting.
  KEY idx_enquiries_created (created_at),
  -- Admin search by contact details.
  KEY idx_enquiries_email (email),
  KEY idx_enquiries_phone (phone)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
