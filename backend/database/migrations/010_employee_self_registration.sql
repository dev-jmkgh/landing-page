-- =============================================================================
-- 010 — Employee self-registration with admin approval
--
-- Telecallers can now register themselves from the mobile app, but cannot sign in
-- until an administrator approves them in the web app.
--
-- THE KEY DESIGN DECISION IS THAT A PENDING USER HAS is_active = 0.
--
-- The alternative — is_active = 1 plus a separate pending flag — was rejected after
-- counting the call sites: nine different queries already gate on is_active = 1
-- (listAssignableEmployees, the dashboard's active-employee count, employeePerformance,
-- lead assignment validation in three places, follow-up assignment in two, and
-- actorFromEmail on the admin cookie path). Every one of them would have needed a second
-- condition added correctly, and missing a single one would leak a pending, unvetted
-- account into lead assignment or the admin session path.
--
-- With is_active = 0 the existing checks already exclude pending users, so the change is
-- fail-closed by default. approval_status then exists only to explain WHY someone is
-- inactive, which matters in exactly one place: the sign-in error message.
-- =============================================================================

ALTER TABLE telecaller_users
  -- The DEFAULT is 'pending', which is FAIL-CLOSED.
  --
  -- 'approved' would have been more convenient — existing rows would need no backfill —
  -- but it makes every future INSERT that forgets this column silently create a working
  -- account. That is the wrong direction for the one column standing between a stranger
  -- with the APK and a live employee login. With 'pending' as the default, a writer that
  -- forgets produces an account that cannot sign in, which is a visible bug rather than
  -- a silent hole.
  --
  -- The cost is that existing rows land on 'pending' and are corrected by the explicit
  -- backfill at the end of this file, and that `insertEmployee` (admin-created staff)
  -- must state 'approved' for itself — it does.
  ADD COLUMN approval_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending'
    AFTER is_active,
  -- Separate from created_at: an admin-created employee has a created_at but was never
  -- "registered", and the approvals queue is ordered by when someone actually applied.
  ADD COLUMN registered_at   DATETIME        NULL AFTER approval_status,
  ADD COLUMN approved_by     BIGINT UNSIGNED NULL AFTER registered_at,
  ADD COLUMN approved_at     DATETIME        NULL AFTER approved_by,
  -- Shown to the applicant on their next sign-in attempt, so a rejection is not silent.
  ADD COLUMN rejection_reason VARCHAR(255)   NULL AFTER approved_at;

-- The approvals queue: pending registrations, oldest first. Small table, but this is a
-- screen an admin opens repeatedly and it should not scan.
ALTER TABLE telecaller_users
  ADD KEY idx_telecaller_users_approval (approval_status, registered_at);

-- =============================================================================
-- Backfill — REQUIRED, not cosmetic.
--
-- The DEFAULT above is 'pending', so the ALTER has just marked every pre-existing
-- employee as awaiting approval. They were created by an administrator and are already
-- trusted, so they are moved to 'approved' here.
--
-- Ordering matters: this must run in the same migration as the ALTER, or the deployment
-- has a window in which every existing telecaller cannot sign in.
-- =============================================================================

UPDATE telecaller_users
   SET approval_status = 'approved',
       approved_at     = COALESCE(approved_at, created_at)
 WHERE approval_status = 'pending'
   AND registered_at IS NULL;
