-- =============================================================================
-- 022 — Follow-up move history
--
-- A follow-up can now be moved to another time, another employee and another
-- lead, one at a time or in bulk when someone leaves. None of the existing
-- records can say afterwards what moved where:
--
--   audit_logs        written after commit and best-effort by design, so it can
--                     miss a move that happened.
--   lead_activities   per lead, so a move between two leads splits the story,
--                     and the follow-up id inside `meta` is not indexed.
--   rescheduled_from  keeps only the previous due time.
--
-- One row per moved follow-up, written in the SAME transaction as the move, so
-- the history cannot disagree with the data. Append-only.
-- =============================================================================

CREATE TABLE IF NOT EXISTS follow_up_moves (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  follow_up_id     BIGINT UNSIGNED NOT NULL,

  -- One id per bulk handover or deactivation, so "what did that handover move"
  -- is one query. NULL for a single move.
  batch_id         CHAR(36)        NULL,
  kind             ENUM('move','handover','deactivation') NOT NULL DEFAULT 'move',

  from_lead_id     BIGINT UNSIGNED NOT NULL,
  to_lead_id       BIGINT UNSIGNED NOT NULL,
  from_assigned_to BIGINT UNSIGNED NULL,
  to_assigned_to   BIGINT UNSIGNED NULL,
  from_due_at      DATETIME        NOT NULL,
  to_due_at        DATETIME        NOT NULL,
  reason           VARCHAR(255)    NULL,

  -- No foreign key to the actor, and the label is denormalised, exactly like
  -- audit_logs: the history of who moved a commitment must survive the deletion
  -- of the account that moved it.
  moved_by         BIGINT UNSIGNED NULL,
  moved_by_label   VARCHAR(190)    NULL,

  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_follow_up_moves_follow_up (follow_up_id, created_at),
  KEY idx_follow_up_moves_batch (batch_id),
  KEY idx_follow_up_moves_from_assignee (from_assigned_to, created_at),

  -- The only foreign key. The history goes with the follow-up it describes,
  -- which is consistent with deleting a lead cascading its follow-ups. There are
  -- deliberately no keys onto leads or employees, so deleting either leaves the
  -- record of what was moved intact.
  CONSTRAINT fk_follow_up_moves_follow_up
    FOREIGN KEY (follow_up_id) REFERENCES follow_ups (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
