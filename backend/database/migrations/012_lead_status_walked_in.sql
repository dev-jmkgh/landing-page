-- =============================================================================
-- 012 — "Walked in" lead status
--
-- A customer who has visited the office in person. It sits between "interested"
-- and "converted": a stronger signal than anything that can be established on a
-- phone call, but not yet a sale.
--
-- WHY IT IS APPENDED TO THE END OF THE ENUM.
--
-- MySQL stores an ENUM as an index into its value list, so the position of every
-- existing value must not move. Appending keeps 'new' = 1 … 'not_reachable' = 10
-- exactly where they are and makes 'walked_in' = 11, so no stored row changes
-- meaning. Inserting it in the middle — where it belongs semantically — would
-- renumber everything after it and silently rewrite the status of every lead
-- past that point. The display order is a UI concern and is handled there.
--
-- The list stays under 255 values, so it still occupies one byte and the column
-- does not change storage size. That is what lets MySQL 8 do this in place
-- rather than copying the whole table, which matters on a live leads table.
--
-- This migration is additive and reversible in practice: nothing is written with
-- the new value until someone chooses it, so rolling the application back leaves
-- only rows an administrator deliberately set.
-- =============================================================================

ALTER TABLE leads
  MODIFY COLUMN status ENUM(
    'new','contacted','interested','not_interested','follow_up',
    'callback_requested','converted','lost','invalid_number','not_reachable',
    'walked_in'
  ) NOT NULL DEFAULT 'new';
