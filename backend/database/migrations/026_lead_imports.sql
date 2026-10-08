-- =============================================================================
-- 026 — Importing leads from a spreadsheet
--
-- An import is two steps: the file is checked and every row given a verdict
-- (the preview), then the good rows are created in batches (the commit). The
-- rows are staged here between the two, which is what makes the commit
-- resumable, idempotent and small enough per request to finish well inside the
-- proxy timeout - without raising the 32 kb JSON body limit or re-uploading the
-- file for every batch. It also leaves a history of imports and a row-level
-- result that can be fetched again.
--
-- No column is added to `leads`, the largest table. lead_import_rows.lead_id is
-- the import-to-lead link, and the lead's activity meta carries the import id
-- for the reverse trace.
--
-- Live progress is always counted from lead_import_rows (GROUP BY state over
-- idx_lead_import_rows_state). Only facts that never change are stored: the
-- file's totals at preview time, and the final snapshot written once at the end.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lead_imports (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  -- Who uploaded it.
  created_by        BIGINT UNSIGNED   NULL,
  -- The original name made safe, for display only. Never a path.
  file_name         VARCHAR(190)      NOT NULL,
  file_kind         ENUM('xlsx','xls','csv') NOT NULL,
  -- "This file was already imported on ..." notices.
  file_sha256       CHAR(64)          NOT NULL,
  file_size         INT UNSIGNED      NOT NULL,
  -- NULL for csv.
  sheet_name        VARCHAR(120)      NULL,
  -- 1-based, as Excel numbers rows.
  header_row        SMALLINT UNSIGNED NOT NULL,
  -- [{index, letter, header, field, matchedBy}]
  column_map        JSON              NOT NULL,
  -- NULL means leave the rows unassigned.
  default_assignee  BIGINT UNSIGNED   NULL,
  -- The resolved, active source slug.
  default_source    VARCHAR(40)       NOT NULL,
  -- A VARCHAR rather than a second copy of the lead status ENUM to keep in step.
  default_status    VARCHAR(30)       NOT NULL DEFAULT 'new',
  state             ENUM('ready','committing','completed','cancelled','expired') NOT NULL DEFAULT 'ready',

  -- Facts about the file at preview time. Immutable.
  total_rows        SMALLINT UNSIGNED NOT NULL,
  ready_rows        SMALLINT UNSIGNED NOT NULL,
  warning_rows      SMALLINT UNSIGNED NOT NULL,
  error_rows        SMALLINT UNSIGNED NOT NULL,
  duplicate_rows    SMALLINT UNSIGNED NOT NULL,

  -- The final snapshot, written once at completion or cancellation and NULL
  -- until then.
  created_count     SMALLINT UNSIGNED NULL,
  skipped_count     SMALLINT UNSIGNED NULL,
  failed_count      SMALLINT UNSIGNED NULL,

  -- The per-import commit lock, so two browser tabs cannot commit the same rows
  -- at once. UTC.
  lock_until        DATETIME          NULL,
  -- How long an unconfirmed preview is kept before it expires.
  expires_at        DATETIME          NOT NULL,
  committed_at      DATETIME          NULL,
  completed_at      DATETIME          NULL,
  created_at        TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The history list, newest first.
  KEY idx_lead_imports_created (created_at),
  -- The "you have an unfinished import" banner.
  KEY idx_lead_imports_creator (created_by, state, created_at),
  -- The opportunistic expiry sweep.
  KEY idx_lead_imports_state (state, expires_at),
  -- The same-file notice.
  KEY idx_lead_imports_sha (file_sha256),

  -- SET NULL: an import's record outlives the accounts it names.
  CONSTRAINT fk_lead_imports_created_by
    FOREIGN KEY (created_by) REFERENCES telecaller_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_imports_default_assignee
    FOREIGN KEY (default_assignee) REFERENCES telecaller_users (id) ON DELETE SET NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lead_import_rows (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  import_id         BIGINT UNSIGNED NOT NULL,
  -- The row number Excel shows. Not `row_number`, which is a reserved word from
  -- MySQL 8.0.2.
  sheet_row         INT UNSIGNED    NOT NULL,
  -- The verdict at preview time.
  outcome           ENUM('ready','warning','error','duplicate_in_file','duplicate_existing') NOT NULL,
  -- The lifecycle. Error and duplicate rows start as not_imported, ready and
  -- warning rows as pending.
  state             ENUM('pending','not_imported','created','skipped','failed') NOT NULL,
  -- The phone match key, to explain an in-file duplicate.
  phone_key         VARCHAR(16)     NULL,
  -- The validated create-lead input minus clientUuid, with the assignee always
  -- explicit (a number or null).
  payload           JSON            NULL,
  -- The original cells as text, aligned with column_map, for the "rows to fix"
  -- download.
  raw               JSON            NULL,
  -- {errors: {field: message}, warnings: {field: message}}
  messages          JSON            NULL,
  duplicate_of_row  INT UNSIGNED    NULL,
  duplicate_lead_id BIGINT UNSIGNED NULL,
  -- Generated at preview and passed to createLead, which is what makes a retried
  -- batch idempotent: a replay returns the lead the first attempt created.
  client_uuid       CHAR(36)        NOT NULL,
  -- The lead this row created.
  lead_id           BIGINT UNSIGNED NULL,
  -- A refusal at commit time, such as a number that was taken after the preview.
  result_message    VARCHAR(255)    NULL,
  processed_at      DATETIME        NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_lead_import_rows_sheet_row (import_id, sheet_row),
  UNIQUE KEY uq_lead_import_rows_client_uuid (client_uuid),
  -- "The next pending rows in sheet order", and the per-state counts.
  KEY idx_lead_import_rows_state (import_id, state, sheet_row),
  -- Supports the foreign key, and the lead-to-import trace.
  KEY idx_lead_import_rows_lead (lead_id),

  -- Foreign key names are global to a database, so each is unique here.
  CONSTRAINT fk_lead_import_rows_import
    FOREIGN KEY (import_id) REFERENCES lead_imports (id) ON DELETE CASCADE,
  CONSTRAINT fk_lead_import_rows_lead
    FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_import_rows_dup_lead
    FOREIGN KEY (duplicate_lead_id) REFERENCES leads (id) ON DELETE SET NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
