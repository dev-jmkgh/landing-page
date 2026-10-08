-- =============================================================================
-- 021 — The company SIM line
--
-- Incoming calls must count only when they arrived on the employee's company
-- SIM. Nothing in the schema knew what that was: `telecaller_users.phone` is an
-- optional personal number, loosely validated and not unique, so every incoming
-- row in a handset's call log was uploaded and counted — personal calls from
-- family and friends included.
--
-- Two halves. The employee row gets a server-owned company number. Each call
-- row records which line received it and how that was verified, so every list,
-- tile and report can apply one predicate: outgoing, or verified incoming.
--
-- NO BACKFILL. An existing `phone` cannot be assumed to be a company SIM, and the
-- legacy incoming rows cannot be proven either way. Their NULL `sim_match` is
-- exactly what identifies them, so they stay in the table, excluded by default.
-- =============================================================================

-- Canonical '+91XXXXXXXXXX'. A system identifier written by the server, not a
-- number "as typed", so the stored-as-entered rule for lead phones does not
-- apply here. `phone` stays as the optional personal number.
ALTER TABLE telecaller_users ADD COLUMN company_phone VARCHAR(16) NULL AFTER phone;

-- A separate statement from the one above on purpose: the generated columns
-- below read `company_phone`, and generating from a column that already exists
-- is the one form every MySQL and MariaDB version this schema supports accepts.
--
-- company_phone_key   the 10-digit national number, for lookups and matching.
--
-- company_phone_claim the same key, but NULL for a rejected registration and for
--                     an approved employee who has been deactivated. MySQL has
--                     no partial index, so this is the generated-column-plus-
--                     UNIQUE pattern of migrations 015 and 019: pending and live
--                     staff cannot share a SIM, and leaving the company releases
--                     the number for the next hire. Reactivating a row whose
--                     number has since been claimed fails on the index, which
--                     the service reports against the company phone field.
--
-- company_sim_*       the latest confirmation from the employee's handset, for
--                     admin visibility. The full history lives in audit_logs.
ALTER TABLE telecaller_users
  ADD COLUMN company_phone_key CHAR(10) GENERATED ALWAYS AS (IF(company_phone IS NULL, NULL, RIGHT(company_phone, 10))) STORED AFTER company_phone,
  ADD COLUMN company_phone_claim CHAR(10) GENERATED ALWAYS AS (IF(company_phone IS NULL OR approval_status = 'rejected' OR (approval_status = 'approved' AND is_active = 0), NULL, RIGHT(company_phone, 10))) STORED AFTER company_phone_key,
  ADD COLUMN company_sim_status ENUM('confirmed','declined') NULL AFTER company_phone_claim,
  ADD COLUMN company_sim_method ENUM('number','confirmed','single_sim') NULL AFTER company_sim_status,
  ADD COLUMN company_sim_label VARCHAR(60) NULL AFTER company_sim_method,
  ADD COLUMN company_sim_slot TINYINT UNSIGNED NULL AFTER company_sim_label,
  ADD COLUMN company_sim_device VARCHAR(120) NULL AFTER company_sim_slot,
  ADD COLUMN company_sim_at DATETIME NULL AFTER company_sim_device;

ALTER TABLE telecaller_users ADD UNIQUE INDEX uq_telecaller_users_company_phone (company_phone_claim);

-- Which line received each call.
--
-- received_on_phone  a snapshot of the company number that took the call. Stamped
--                    by the SERVER from telecaller_users.company_phone, never taken
--                    from the client, so it stays correct after a SIM is handed
--                    to someone else. For a future telephony provider it holds
--                    the dialled number.
--
-- sim_match          how the line was verified.
--                    'number'     the handset read the SIM's own number and it
--                                 equals the registered one
--                    'confirmed'  the employee confirmed this SIM as the company
--                                 SIM on this handset
--                    'single_sim' the call-log row named no SIM and the confirmed
--                                 company SIM was the only one present
--                    'provider'   a telephony provider's dialled number
--                    NULL         not verified - every row before this
--                                 migration, and every outgoing row
--
-- Appended at the end of the table so MySQL 8.0 can add them in place.
ALTER TABLE calls
  ADD COLUMN received_on_phone VARCHAR(16) NULL,
  ADD COLUMN sim_match ENUM('number','confirmed','single_sim','provider') NULL;

-- The admin Incoming view filters on direction and sorts by started_at across
-- every employee. idx_calls_started has no direction, so that list scanned it.
ALTER TABLE calls ADD INDEX idx_calls_direction_started (direction, started_at);
