-- =============================================================================
-- 023 — Daily report runs
--
-- The daily telecalling summary is emailed once per IST day by an in-process
-- scheduler, and can also be sent by hand from the admin screen. More than one
-- API process can be running, a process can restart mid-send, and a retry must
-- never mail the administrators twice. The database is the only thing all of
-- those agree on, so it decides.
--
-- ONE SCHEDULED RUN PER (report_type, IST date), ENFORCED HERE.
-- `scheduled_date` is the report date for scheduled rows and NULL for manual
-- ones. A UNIQUE index ignores NULLs, so a second scheduled claim for a date is
-- refused while any number of manual "send now" rows can coexist - the same
-- generated-column technique as migration 019's open_marker. A retry reuses its
-- row (attempts + 1), so the guarantee survives restarts.
--
-- claim_token and lease_expires_at give guarded ownership. Every transition is
-- an UPDATE matched on id AND claim_token, so a process that lost its lease
-- updates nothing and stops BEFORE talking to the mail server.
-- =============================================================================

CREATE TABLE IF NOT EXISTS report_runs (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- A plain string validated in code, like lead_activities.type, so a weekly or
  -- monthly report needs no ALTER. The daily summary is 'telecalling_daily'.
  report_type        VARCHAR(40)     NOT NULL,
  -- The IST calendar day the report covers. Bound as 'YYYY-MM-DD' and read back
  -- with DATE_FORMAT, because a bare DATE otherwise becomes midnight UTC.
  report_date        DATE            NOT NULL,
  trigger_kind       ENUM('scheduled','manual') NOT NULL,
  status             ENUM('claimed','sending','sent','partial','failed','skipped') NOT NULL DEFAULT 'claimed',

  -- generation_failed, mail_rejected, no_recipients, mail_not_configured or
  -- interrupted. `error` is a sentence composed by the service - raw driver and
  -- mail-server text goes to the log only, the same rule as the error handler.
  failure_reason     VARCHAR(40)     NULL,
  error              VARCHAR(255)    NULL,
  attempts           TINYINT UNSIGNED NOT NULL DEFAULT 1,

  -- A fresh UUID per claim or reclaim. claimed_by (host and pid) is diagnostic
  -- only and never used to decide anything.
  claim_token        CHAR(36)        NOT NULL,
  claimed_by         VARCHAR(120)    NULL,
  claimed_at         DATETIME        NOT NULL,
  lease_expires_at   DATETIME        NOT NULL,
  finished_at        DATETIME        NULL,

  recipient_count    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  delivered_count    SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- A copy of the figures as they were sent - a record of what the email said,
  -- never read back to compute anything, so it is not a stored derived value.
  summary            JSON            NULL,

  -- No foreign key and a denormalised label, exactly like audit_logs: the run
  -- history must survive the deletion of the account that asked for it.
  requested_by       BIGINT UNSIGNED NULL,
  requested_by_label VARCHAR(190)    NULL,

  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  scheduled_date     DATE GENERATED ALWAYS AS (IF(trigger_kind = 'scheduled', report_date, NULL)) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_report_runs_one_scheduled (report_type, scheduled_date),
  -- The history list on the admin screen, newest report first.
  KEY idx_report_runs_history (report_type, report_date, id)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- The two operational switches, in the 009 settings-seed style. ON DUPLICATE
-- KEY UPDATE touches only the description, so an administrator who has already
-- changed the time or turned the email off keeps their choice.
INSERT INTO system_settings (setting_key, setting_value, description) VALUES
  ('report.daily_email_enabled',
   'true',
   'Email the telecalling summary for the previous day to the administrators every morning.'),
  ('report.daily_email_time',
   '"08:00"',
   'When the daily summary is sent, as 24-hour IST time (HH:MM). It always covers the whole previous day.')
ON DUPLICATE KEY UPDATE description = VALUES(description);
