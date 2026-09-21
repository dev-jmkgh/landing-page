-- Makes "does another lead already have this number?" a fast, exact question.
--
-- The rule itself — one active lead per number — is enforced in `createLead` and
-- `editLead`, NOT by a unique index here. That is a deliberate choice and the reason is
-- the data already in the table: some numbers are held by two active leads today, each
-- with its own calls and notes, sometimes owned by different telecallers. A unique index
-- cannot be added while they exist, and the only ways to add one are to refuse the
-- deploy until somebody resolves them by hand, or to have a migration pick a survivor and
-- silently discard the other customer's history. Neither is acceptable for a rule that is
-- only meant to apply from now on.
--
-- So the constraint lives in the service, which applies to every lead created from this
-- point, and leaves the existing ones exactly as they are. The one thing this gives up is
-- the two-requests-in-the-same-instant case: both pass the check, both insert, and no
-- index refuses the second. That window is small and the alternative was worse; see
-- `npm run leads:duplicates`, which lists any that appear.
--
-- WHY THE GENERATED COLUMN IS STILL WORTH IT
-- ------------------------------------------
-- The check now runs on every lead create and every phone edit, and it used to compare
-- with `LIKE '%<digits>'` — a leading wildcard, which no index can serve, so each check
-- was a full scan of the leads table. `phone_key` holds the trailing nine digits of
-- whatever was typed, so `+91 98765 43210`, `09876543210` and `9876543210` collapse to
-- one value an ordinary index can look up.
--
-- It is NULL for an archived lead, which is what lets archiving release a number: the
-- service matches on this column, so a retired record stops answering to its old number
-- and the correct one can finally be entered.
ALTER TABLE leads
  ADD COLUMN phone_key VARCHAR(16)
    GENERATED ALWAYS AS (
      IF(is_archived = 0, RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 9), NULL)
    ) STORED;

-- Not UNIQUE, for the reason above. Existing duplicates stay; new ones are refused by
-- the service before they reach the table.
CREATE INDEX idx_leads_phone_key ON leads (phone_key);
