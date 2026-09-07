-- =============================================================================
-- 009 — Lead activity, audit log, in-app notifications, system settings
--
-- `lead_activities` and `audit_logs` are deliberately two tables. They answer
-- different questions, are read at wildly different rates, and have different
-- retention and visibility rules:
--
--   lead_activities — the story of one customer relationship. Read on every
--                     lead-detail open by both clients. Shown to telecallers.
--   audit_logs      — who did what to the system. Read rarely, kept longer,
--                     never shown to a telecaller.
--
-- Collapsing them into one table would mean either showing a telecaller the
-- record of their own account being deactivated, or filtering it out on every
-- single timeline read.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_activities (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  lead_id    BIGINT UNSIGNED NOT NULL,
  -- NULL for system-generated activity (an automatic assignment, a webhook).
  user_id    BIGINT UNSIGNED NULL,

  -- A plain string rather than an ENUM: new activity kinds arrive with every
  -- feature, and an ALTER TABLE on the largest table in the schema is a poor
  -- price for adding a timeline entry. The known values are listed in the
  -- telecalling-backend skill and enforced by the Zod schema.
  type       VARCHAR(40)     NOT NULL,
  -- Pre-rendered one-line description, written once at the time of the event.
  -- Composing it at read time would mean re-deriving it from `meta` in both
  -- clients, and it would change retroactively whenever the wording changed —
  -- a timeline should say what it said when it happened.
  summary    VARCHAR(255)    NOT NULL,
  -- Structured detail for clients that want to render more than the summary:
  -- from/to status, previous owner, call duration. Never required for display.
  meta       JSON            NULL,

  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The only query this table serves: one lead's timeline, newest first.
  KEY idx_lead_activities_lead (lead_id, created_at),
  -- Per-employee activity feed on the admin employee-detail screen.
  KEY idx_lead_activities_user (user_id, created_at),

  CONSTRAINT fk_lead_activities_lead
    FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE,
  CONSTRAINT fk_lead_activities_user
    FOREIGN KEY (user_id) REFERENCES telecaller_users (id) ON DELETE SET NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- =============================================================================
-- Audit log
--
-- No foreign key to the actor, and `actor_label` duplicates their name and
-- email on purpose. An audit entry must survive the deletion of the account it
-- describes — "who deactivated this employee" cannot become NULL because the
-- person who did it later left.
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  actor_type  ENUM('admin','employee','system') NOT NULL DEFAULT 'employee',
  actor_id    BIGINT UNSIGNED NULL,
  actor_label VARCHAR(190)    NULL,

  action      VARCHAR(60)     NOT NULL,
  entity_type VARCHAR(40)     NOT NULL,
  entity_id   BIGINT UNSIGNED NULL,
  summary     VARCHAR(255)    NOT NULL,
  meta        JSON            NULL,
  ip_address  VARCHAR(45)     NULL,

  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_audit_logs_created (created_at),
  KEY idx_audit_logs_actor (actor_id, created_at),
  KEY idx_audit_logs_entity (entity_type, entity_id, created_at),
  KEY idx_audit_logs_action (action, created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- =============================================================================
-- In-app notifications
--
-- Stored as well as pushed. A push notification is fire-and-forget — it is lost
-- if the device is off, the token has expired, or the employee cleared the
-- shade — so the app also has a notification list to come back to, and the
-- unread count is authoritative here rather than on the handset.
-- =============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,

  kind         VARCHAR(40)     NOT NULL,
  title        VARCHAR(190)    NOT NULL,
  body         VARCHAR(500)    NULL,

  -- Deep-link targets, so tapping the notification opens the thing it is about.
  lead_id      BIGINT UNSIGNED NULL,
  follow_up_id BIGINT UNSIGNED NULL,

  read_at      DATETIME        NULL,
  -- Whether the push was actually handed to the transport. Separate from
  -- read_at: an unpushed notification is still visible in the in-app list.
  pushed_at    DATETIME        NULL,

  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The notification list, and the unread badge count.
  KEY idx_notifications_user_created (user_id, created_at),
  KEY idx_notifications_user_unread (user_id, read_at),

  CONSTRAINT fk_notifications_user
    FOREIGN KEY (user_id) REFERENCES telecaller_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_lead
    FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_follow_up
    FOREIGN KEY (follow_up_id) REFERENCES follow_ups (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- =============================================================================
-- System settings
--
-- A key/value table rather than one column per setting. These are operational
-- switches an admin flips — recording on or off, reminder lead time, working
-- hours — and each one should not cost a migration. `setting_key`, not `key`,
-- which is reserved in MySQL.
-- =============================================================================

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key  VARCHAR(80)     NOT NULL,
  setting_value JSON           NOT NULL,
  description  VARCHAR(255)    NULL,
  updated_by   BIGINT UNSIGNED NULL,
  updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (setting_key)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('recording.enabled',
   'false',
   'Master switch for call recording. Off until a telephony provider is connected — on-device recording is blocked by Android 10+ and by iOS.'),
  ('recording.announce',
   'true',
   'Play a recording announcement to the customer before the call connects. Keep enabled: notifying the other party is a legal requirement.'),
  ('followup.reminder_minutes',
   '30',
   'How many minutes before a follow-up is due to send the reminder.'),
  ('followup.overdue_alert_hours',
   '24',
   'How long a follow-up may stay overdue before the admin alert fires.'),
  ('assignment.strategy',
   '"manual"',
   'How new leads are assigned: manual, round_robin, or load_based.'),
  ('calling.working_hours',
   '{"start":"09:30","end":"18:30","timezone":"Asia/Kolkata"}',
   'Advisory calling window shown in the app. Not enforced.')
ON DUPLICATE KEY UPDATE description = VALUES(description);
