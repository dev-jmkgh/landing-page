-- =============================================================================
-- 011 — Mandatory email verification for employee self-registration
--
-- Registration from the mobile app now proves the applicant controls the address
-- they typed, before an administrator is asked to approve them.
--
-- WHY THIS IS A SEPARATE GATE FROM approval_status.
--
-- They answer different questions and neither substitutes for the other:
--
--   email_verified_at  — does this person control this mailbox? Decided by the
--                        applicant, automatically, in a minute.
--   approval_status    — should this person work our leads? Decided by a human,
--                        deliberately, and reversibly.
--
-- Folding verification into approval_status (a fourth 'unverified' state) was
-- rejected: an administrator would then see unverified strangers in the approvals
-- queue and have to remember which state meant what, and a typo'd address would sit
-- there forever looking like a decision waiting to be made rather than a dead
-- registration.
--
-- FAIL-CLOSED, with the same reasoning as 010's approval_status default.
--
-- The column is NULL by default, and NULL means unverified. Sign-in refuses a NULL,
-- and so does approval — so an INSERT that forgets this column produces an account
-- that cannot be used, which is a visible bug rather than a silent hole.
--
-- The backfill at the end is what stops that default locking out everyone who
-- already exists.
-- =============================================================================

ALTER TABLE telecaller_users
  -- NULL until proven. Placed next to `email` because it is a property of the
  -- address, not of the employment.
  ADD COLUMN email_verified_at DATETIME NULL AFTER email;

-- -----------------------------------------------------------------------------
-- One-time codes
-- -----------------------------------------------------------------------------
--
-- A separate table rather than columns on telecaller_users, for three reasons:
--
--   1. A code has its own lifetime, attempt count and consumption, none of which
--      belong on the employee record.
--   2. Re-issuing must invalidate what came before. That is one UPDATE over rows
--      belonging to a user, not a read-modify-write of a single column.
--   3. Rows are disposable. They can be pruned on a schedule without touching the
--      accounts they refer to.
CREATE TABLE IF NOT EXISTS employee_email_otps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,

  -- SHA-256 of the code, never the code itself.
  --
  -- Hashed for the same reason a password is: this table is what an attacker reads
  -- if they get SELECT on the database, and a plaintext column would hand them
  -- every live verification code.
  --
  -- SHA-256 rather than bcrypt, deliberately. A six-digit code has ~20 bits of
  -- entropy, so no hash function makes it resistant to an offline search — what
  -- makes it safe is that it expires in minutes and dies after five wrong guesses
  -- (see `attempts`). Bcrypt would add hundreds of milliseconds to every
  -- verification for no gain against the only attack that matters, and would make
  -- the endpoint itself a denial-of-service lever.
  code_hash CHAR(64) NOT NULL,

  expires_at DATETIME NOT NULL,

  -- Set when the code is successfully used. A consumed code is never accepted
  -- again, so a code read from someone's inbox after the fact is worthless.
  consumed_at DATETIME NULL,

  -- Wrong guesses against THIS code. The cap is enforced in the service; storing
  -- it here means the limit survives a restart and cannot be reset by reconnecting.
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- Every lookup is "the newest live code for this user", so the index carries
  -- user_id first and the expiry with it.
  KEY idx_email_otps_user (user_id, expires_at),

  -- ON DELETE CASCADE: a code has no meaning without its account, and a deleted
  -- registration should not leave a live verification token behind.
  CONSTRAINT fk_email_otps_user FOREIGN KEY (user_id)
    REFERENCES telecaller_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Backfill: everyone who already exists is treated as verified
-- -----------------------------------------------------------------------------
--
-- Without this, the fail-closed NULL default would lock every current employee out
-- of the mobile app the moment this migration ran — including the administrators who
-- would have to fix it.
--
-- It is also correct on the merits rather than merely convenient: every row that
-- exists before this migration was either created by an administrator who typed the
-- address themselves, or was already approved by one. Neither is a stranger's
-- unverified claim, which is the only thing this gate exists to stop.
--
-- `created_at` is used rather than NOW() so the timestamp does not assert that these
-- addresses were confirmed at the moment of the deploy.
UPDATE telecaller_users
   SET email_verified_at = created_at
 WHERE email_verified_at IS NULL;
