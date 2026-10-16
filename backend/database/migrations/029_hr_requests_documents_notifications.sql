-- =============================================================================
-- 029 — HR requests, employee documents and the HR notification inbox
--
-- Employee self-service: raise a request with HR and follow it, ask for a change
-- to your own record, read the documents HR has shared with you, and be told
-- when something you are waiting on moves.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- HR requests
-- -----------------------------------------------------------------------------
--
-- A request is a conversation with a status. `payload` carries structured data
-- for the categories that need it — for 'profile_update' it is the set of
-- fields the employee wants changed and their new values, which HR applies to
-- hr_users in one step when it resolves the request. Every other category is
-- free text.
CREATE TABLE IF NOT EXISTS hr_requests (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,

  category         ENUM('profile_update','letter','payroll','attendance','leave','it','other')
                   NOT NULL DEFAULT 'other',
  subject          VARCHAR(160)    NOT NULL,
  details          VARCHAR(2000)   NULL,
  payload          JSON            NULL,

  -- open        — raised, nobody has picked it up
  -- in_progress — HR is working on it
  -- resolved    — done. For a profile update, the change has been applied.
  -- rejected    — HR declined it, with a note
  -- cancelled   — withdrawn by the employee before it was resolved
  status           ENUM('open','in_progress','resolved','rejected','cancelled')
                   NOT NULL DEFAULT 'open',

  -- Idempotency, as on leave requests: one submission is one request.
  client_key       VARCHAR(64)     NULL,

  resolved_by      BIGINT UNSIGNED NULL,
  resolved_by_name VARCHAR(120)    NULL,
  resolved_at      DATETIME        NULL,
  resolution_note  VARCHAR(1000)   NULL,

  -- Bumped by every comment and status change, so the employee's list can sort
  -- by "something happened" rather than by when it was raised.
  last_activity_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_requests_client (user_id, client_key),
  KEY idx_hr_requests_user (user_id, last_activity_at),
  KEY idx_hr_requests_queue (status, created_at),
  KEY idx_hr_requests_category (category, status),
  CONSTRAINT fk_hr_requests_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- The timeline of a request: comments from either side, and status changes.
CREATE TABLE IF NOT EXISTS hr_request_comments (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id   BIGINT UNSIGNED NOT NULL,

  -- 'employee' is hr_users.id, 'admin' is the admin portal actor, 'system' has
  -- no author. author_name is a snapshot so the timeline survives renames.
  author_type  ENUM('employee','admin','system') NOT NULL,
  author_id    BIGINT UNSIGNED NULL,
  author_name  VARCHAR(120)    NULL,

  body         VARCHAR(2000)   NULL,
  -- Set when this entry records a status change.
  status_from  VARCHAR(20)     NULL,
  status_to    VARCHAR(20)     NULL,

  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_hr_request_comments_request (request_id, id),
  CONSTRAINT fk_hr_request_comments_request
    FOREIGN KEY (request_id) REFERENCES hr_requests (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Documents HR shares
-- -----------------------------------------------------------------------------
--
-- `user_id` NULL is a company-wide document (a policy handbook) that every
-- employee can read. Otherwise it belongs to one employee (an offer letter).
--
-- The file lives in the same storage the resume uploads use — a private S3
-- bucket or a directory outside the web root — and `storage_key` is the opaque
-- handle to it. The bytes never pass through a public URL.
--
-- Removed documents are soft-deleted: `deleted_at` hides them everywhere, and
-- the row remains as the record that the employee once had access.
CREATE TABLE IF NOT EXISTS hr_documents (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NULL,
  title          VARCHAR(160)    NOT NULL,
  category       ENUM('policy','letter','contract','identity','payroll','other')
                 NOT NULL DEFAULT 'other',
  storage_key    VARCHAR(255)    NOT NULL,
  original_name  VARCHAR(255)    NOT NULL,
  mime_type      VARCHAR(100)    NOT NULL,
  size_bytes     INT UNSIGNED    NOT NULL,
  -- Shared in answer to an HR request, when that is how it arrived.
  request_id     BIGINT UNSIGNED NULL,
  uploaded_by    BIGINT UNSIGNED NULL,
  uploaded_by_name VARCHAR(120)  NULL,
  deleted_at     DATETIME        NULL,
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_hr_documents_user (user_id, deleted_at, created_at),
  KEY idx_hr_documents_request (request_id),
  CONSTRAINT fk_hr_documents_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_hr_documents_request
    FOREIGN KEY (request_id) REFERENCES hr_requests (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- The HR notification inbox
-- -----------------------------------------------------------------------------
--
-- Its OWN table, not the telecalling `notifications` one, whose user_id points
-- at telecaller_users. Same separation as everything else in the HR module.
--
-- `dedupe_key` makes a scheduled reminder idempotent: "check-in reminder for
-- 2026-10-16" is written at most once per person however often the scheduler
-- runs, because the second insert hits the unique key. NULL for one-off events,
-- which never collide.
CREATE TABLE IF NOT EXISTS hr_notifications (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  kind         VARCHAR(40)     NOT NULL,
  title        VARCHAR(160)    NOT NULL,
  body         VARCHAR(500)    NULL,
  -- What the notification is about, so the app can open it.
  entity_type  VARCHAR(40)     NULL,
  entity_id    BIGINT UNSIGNED NULL,
  dedupe_key   VARCHAR(80)     NULL,
  read_at      DATETIME        NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_notifications_dedupe (user_id, dedupe_key),
  KEY idx_hr_notifications_inbox (user_id, id),
  KEY idx_hr_notifications_unread (user_id, read_at),
  CONSTRAINT fk_hr_notifications_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
