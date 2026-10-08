-- =============================================================================
-- 020 — Notes and follow-ups looked up by the call they belong to
--
-- Three screens now start from a CALL rather than from a lead: the admin call
-- list's Notes column, the admin Lead View's per-call history, and the mobile
-- My Activity call list with its call detail. Each asks "what was written and
-- booked on this call", and until now nothing could answer the second half: a
-- follow-up booked from the post-call sheet recorded which lead it was for but
-- not which call it came from.
--
-- No backfill. Pairing old follow-ups to calls by timestamp would be a guess,
-- and a wrong pairing puts a commitment against the wrong conversation. Old
-- rows keep NULL, which truthfully means "not booked from a known call".
-- =============================================================================

-- The call list's Notes column reads the notes for one page of calls in a single
-- query (WHERE call_id IN the page ids). lead_notes has never been indexed on
-- call_id, so without this that query scans the whole table on every page.
ALTER TABLE lead_notes ADD INDEX idx_lead_notes_call (call_id, created_at);

-- The call a follow-up was booked from.
--
-- Nullable because most follow-ups have no call behind them: the follow-ups
-- screen and the status endpoint book them directly. Saving a call write-up
-- again finds its pending follow-up through this column and moves it, instead
-- of adding a second one.
ALTER TABLE follow_ups ADD COLUMN call_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER lead_id;

-- SET NULL, not CASCADE: a call can disappear with its employee's row, and the
-- commitment made to the customer on that call must not disappear with it.
-- The key carries state so "the pending follow-up booked on this call" is one
-- index lookup.
ALTER TABLE follow_ups
  ADD KEY idx_follow_ups_call (call_id, state),
  ADD CONSTRAINT fk_follow_ups_call FOREIGN KEY (call_id) REFERENCES calls (id) ON DELETE SET NULL;

-- Idempotency key of the most recent write-up of this call.
--
-- Writing up a call is retried by the mobile offline queue like every other
-- mutation, and a replay used to append a second note, a second follow-up and a
-- second timeline row. A UNIQUE index allows any number of NULLs, so calls that
-- were never written up through a keyed request are unaffected.
ALTER TABLE calls ADD COLUMN record_client_uuid CHAR(36) NULL DEFAULT NULL AFTER recorded_at;

ALTER TABLE calls ADD UNIQUE INDEX uq_calls_record_client_uuid (record_client_uuid);

-- My Activity: one employee's calls in one direction, newest first, paged by a
-- (started_at, id) keyset. InnoDB appends the primary key to a secondary index,
-- so the keyset tie-break is served too. idx_calls_user_started already covers
-- the unfiltered list.
ALTER TABLE calls ADD INDEX idx_calls_user_direction_started (user_id, direction, started_at);
