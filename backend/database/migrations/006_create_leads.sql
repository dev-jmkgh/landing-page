-- =============================================================================
-- 006 — Leads, configurable lead sources, and lead notes
--
-- A lead is the central record of the telecalling system: a customer to call,
-- who owns them, what state the conversation is in, and everything that has
-- happened. Calls, follow-ups, notes and activity all hang off this table.
-- =============================================================================

-- Sources are a table rather than an ENUM because admins configure them
-- (spec: System Settings, Lead Source Management). The seeded rows match the
-- shared vocabulary in the telecalling-spec skill; `leads.source` stores the
-- slug as a plain string so a source can be renamed or retired without
-- rewriting historical leads or running an ALTER on a large table.
CREATE TABLE IF NOT EXISTS lead_sources (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(40)     NOT NULL,
  label      VARCHAR(120)    NOT NULL,
  is_active  TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order SMALLINT        NOT NULL DEFAULT 100,
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_lead_sources_slug (slug)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

INSERT INTO lead_sources (slug, label, sort_order) VALUES
  ('website',       'Website',        10),
  ('advertisement', 'Advertisement',  20),
  ('referral',      'Referral',       30),
  ('manual',        'Manual entry',   40),
  ('hard_copy',     'Hard copy',      50),
  ('other',         'Other',          90)
ON DUPLICATE KEY UPDATE label = VALUES(label), sort_order = VALUES(sort_order);

CREATE TABLE IF NOT EXISTS leads (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Quoted to the customer and searched on by staff, e.g. LD-8F3K2A.
  reference         VARCHAR(16)     NOT NULL,

  customer_name     VARCHAR(120)    NOT NULL,
  phone             VARCHAR(20)     NOT NULL,
  alternate_phone   VARCHAR(20)     NULL,
  email             VARCHAR(190)    NULL,
  address           VARCHAR(500)    NULL,
  city              VARCHAR(120)    NULL,

  -- Slug from `lead_sources`. Not a foreign key: retiring a source must not be
  -- blocked by, or cascade into, thousands of historical leads.
  source            VARCHAR(40)     NOT NULL DEFAULT 'manual',
  product_interest  VARCHAR(190)    NULL,
  status            ENUM(
                      'new','contacted','interested','not_interested','follow_up',
                      'callback_requested','converted','lost','invalid_number','not_reachable'
                    ) NOT NULL DEFAULT 'new',

  -- NULL means unassigned, which is a first-class state: the admin dashboard has
  -- an unassigned queue and the assignment screen works from it.
  assigned_to       BIGINT UNSIGNED NULL,
  assigned_at       DATETIME        NULL,
  assigned_by       BIGINT UNSIGNED NULL,
  created_by        BIGINT UNSIGNED NULL,

  -- Set when a lead originates from a website enquiry, so the two records can be
  -- reconciled and the same customer is not called twice from two systems.
  enquiry_id        BIGINT UNSIGNED NULL,

  -- Photo of a paper lead (spec: Module 4). An opaque storage key handled by
  -- services/storage, never a path or a public URL.
  attachment_key    VARCHAR(255)    NULL,
  attachment_mime   VARCHAR(100)    NULL,

  -- Free-text summary shown at the top of the lead. The full history lives in
  -- `lead_notes`; this is the "what you need to know before dialling" field.
  summary_note      TEXT            NULL,

  -- Maintained caches, written in the same transaction as the change they
  -- describe. These are NOT the derived values the backend skill forbids: those
  -- (overdue, conversion rate, call counts) need a cron job to stay true and so
  -- are always computed at query time. These two cannot drift, and they exist
  -- because the lead list sorts and filters on them on every screen in both
  -- clients — a correlated subquery per row would dominate the query cost.
  last_contacted_at DATETIME        NULL,
  next_follow_up_at DATETIME        NULL,

  converted_at      DATETIME        NULL,
  -- Archive rather than delete, so the activity trail and reports stay honest.
  -- Hard deletion is a separate, audited admin action.
  is_archived       TINYINT(1)      NOT NULL DEFAULT 0,

  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_leads_reference (reference),

  -- The mobile lead list: one employee's active leads, newest first.
  KEY idx_leads_assigned_status (assigned_to, is_archived, status),
  -- The mobile dashboard's follow-up queue and the "call next" ordering.
  KEY idx_leads_assigned_followup (assigned_to, next_follow_up_at),
  -- Admin list view and the unassigned queue.
  KEY idx_leads_status_created (status, created_at),
  KEY idx_leads_assigned_to (assigned_to),
  -- Duplicate detection before creating a lead, and incoming-call matching:
  -- an unknown number ringing a telecaller is looked up here first.
  KEY idx_leads_phone (phone),
  KEY idx_leads_alternate_phone (alternate_phone),
  -- Source conversion reporting (spec: Module 13).
  KEY idx_leads_source_status (source, status),
  KEY idx_leads_created (created_at),
  KEY idx_leads_enquiry (enquiry_id),

  CONSTRAINT fk_leads_assigned_to
    FOREIGN KEY (assigned_to) REFERENCES telecaller_users (id) ON DELETE SET NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- =============================================================================
-- Lead notes
--
-- Append-only. A note is what someone believed at a point in time, and editing
-- it would rewrite the record of a conversation that has already happened.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_notes (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  lead_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NULL,
  -- 'requirement' is separated out because the spec asks for customer
  -- requirements specifically, and they are worth surfacing apart from the
  -- running commentary.
  kind        ENUM('note','requirement','call_note','system') NOT NULL DEFAULT 'note',
  body        TEXT            NOT NULL,
  -- Set when the note was written on the back of a specific call.
  call_id     BIGINT UNSIGNED NULL,
  -- Idempotency key from the mobile offline queue. A retry after an ambiguous
  -- timeout must not post the same note twice.
  client_uuid CHAR(36)        NULL,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_lead_notes_client_uuid (client_uuid),
  KEY idx_lead_notes_lead (lead_id, created_at),
  KEY idx_lead_notes_user (user_id, created_at),

  CONSTRAINT fk_lead_notes_lead
    FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE,
  CONSTRAINT fk_lead_notes_user
    FOREIGN KEY (user_id) REFERENCES telecaller_users (id) ON DELETE SET NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
