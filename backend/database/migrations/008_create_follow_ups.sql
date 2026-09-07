-- =============================================================================
-- 008 — Follow-ups
--
-- Note what is NOT here: no `is_overdue` and no `is_missed` column. Both are
-- derived at query time from `state = 'pending' AND due_at < NOW()`. A stored
-- flag would need a scheduled job to stay true, and the first missed run would
-- leave overdue follow-ups looking fine — a silent failure in the one feature
-- whose whole purpose is not letting things slip.
-- =============================================================================

CREATE TABLE IF NOT EXISTS follow_ups (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  lead_id       BIGINT UNSIGNED NOT NULL,

  -- Who owes the call. Usually the lead's owner, but an admin can reassign a
  -- follow-up on its own (spec: Module 8) — for instance when someone is on
  -- leave — without transferring the whole lead.
  assigned_to   BIGINT UNSIGNED NULL,
  created_by    BIGINT UNSIGNED NULL,

  due_at        DATETIME        NOT NULL,
  note          VARCHAR(1000)   NULL,
  state         ENUM('pending','completed','cancelled') NOT NULL DEFAULT 'pending',

  completed_at  DATETIME        NULL,
  completed_by  BIGINT UNSIGNED NULL,
  outcome_note  VARCHAR(1000)   NULL,

  -- Rescheduling keeps one row and moves `due_at`, recording where it came from
  -- so the timeline can say "moved from Tuesday" rather than showing a
  -- cancelled follow-up next to a new one.
  rescheduled_from DATETIME     NULL,
  reschedule_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- Set when the reminder push has gone out, so a retry or a second worker pass
  -- cannot notify the same employee twice about the same follow-up.
  reminder_sent_at DATETIME     NULL,

  -- Idempotency key from the mobile offline queue.
  client_uuid   CHAR(36)        NULL,

  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_follow_ups_client_uuid (client_uuid),

  -- The query behind almost every follow-up screen in both clients: one
  -- employee's pending follow-ups ordered by when they are due. Serves today's
  -- list, the upcoming list and the overdue list from one index.
  KEY idx_follow_ups_assignee_state_due (assigned_to, state, due_at),
  -- The lead's own follow-up history, and the timeline.
  KEY idx_follow_ups_lead (lead_id, due_at),
  -- Admin-wide today/overdue views across all employees.
  KEY idx_follow_ups_state_due (state, due_at),
  -- The reminder sweep: pending, due soon, not yet notified.
  KEY idx_follow_ups_reminder (state, due_at, reminder_sent_at),

  CONSTRAINT fk_follow_ups_lead
    FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE,
  CONSTRAINT fk_follow_ups_assignee
    FOREIGN KEY (assigned_to) REFERENCES telecaller_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_follow_ups_completed_by
    FOREIGN KEY (completed_by) REFERENCES telecaller_users (id) ON DELETE SET NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
