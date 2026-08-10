-- =============================================================================
-- 004 — Extend career applications
--
-- Adds the optional applicant details collected by the Apply Now form, and moves
-- `status` onto the review vocabulary the business actually uses.
--
-- The resume itself is unchanged: the file stays on disk outside the web root and
-- `resume_filename` remains the randomised storage key. No second storage system is
-- introduced and no publicly guessable URL is stored.
-- =============================================================================

ALTER TABLE job_applications
  ADD COLUMN linkedin_url  VARCHAR(255) NULL AFTER message,
  ADD COLUMN portfolio_url VARCHAR(255) NULL AFTER linkedin_url,
  ADD COLUMN experience    VARCHAR(60)  NULL AFTER portfolio_url,
  ADD COLUMN location      VARCHAR(120) NULL AFTER experience;

-- Widen the enum first so both the old and the new vocabulary are legal, otherwise
-- MySQL would coerce every existing row to an empty string during the change.
ALTER TABLE job_applications
  MODIFY COLUMN status ENUM(
    'new','contacted','in_progress','closed',
    'reviewing','shortlisted','rejected','hired'
  ) NOT NULL DEFAULT 'new';

-- Carry existing rows across. 'contacted' and 'in_progress' both describe an
-- application under active review; 'closed' becomes 'rejected', which is the only
-- terminal state in the new vocabulary that a closed application can mean.
UPDATE job_applications SET status = 'reviewing'  WHERE status IN ('contacted', 'in_progress');
UPDATE job_applications SET status = 'rejected'   WHERE status = 'closed';

-- Then narrow to the final set: new → reviewing → shortlisted → rejected / hired.
ALTER TABLE job_applications
  MODIFY COLUMN status ENUM(
    'new','reviewing','shortlisted','rejected','hired'
  ) NOT NULL DEFAULT 'new';
