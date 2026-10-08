-- =============================================================================
-- 024 — Indexes for the dashboard charts, the daily email and the follow-up tabs
--
-- No new columns. Every figure stays derived at query time, as the backend
-- skill requires ("Derived values are never stored"). These make the queries
-- that derive them read an index instead of the table. Applied late, they make
-- those queries slower, never wrong.
--
-- One index per statement. MySQL commits DDL implicitly, so a file that fails
-- part-way keeps the indexes it had already built, and keeping each one a
-- separate statement makes it obvious which did. Written as ALTER TABLE ... ADD
-- INDEX rather than CREATE INDEX: the application's database user runs the
-- migrations, and CREATE INDEX needs an INDEX privilege it may not have.
-- =============================================================================

-- Calls per IST bucket: a range on started_at with outcome, direction and
-- duration read for every row in it. With all four in one key the chart and the
-- daily email aggregate from the index alone. idx_calls_started (007) stays -
-- the call list orders by it.
ALTER TABLE calls ADD INDEX idx_calls_started_cover (started_at, outcome, direction, duration_seconds);

-- Follow-ups whose due date falls in a period, across every state: the
-- follow-up chart and the follow-up list's from/to filter. Every existing
-- due_at key (008) leads with assigned_to or state, so this predicate scanned.
ALTER TABLE follow_ups ADD INDEX idx_follow_ups_due (due_at, state, completed_at);

-- "Completed today" (dashboard tile, follow-up tab and daily email), and the
-- Completed tab ordered by completion time.
ALTER TABLE follow_ups ADD INDEX idx_follow_ups_state_completed (state, completed_at);

-- Follow-ups booked in a period: the Reports follow-up cohort and the daily
-- email. created_at had no index at all.
ALTER TABLE follow_ups ADD INDEX idx_follow_ups_created (created_at);

-- Conversions by the day they happened. Nothing indexed converted_at.
ALTER TABLE leads ADD INDEX idx_leads_status_converted (status, converted_at);
