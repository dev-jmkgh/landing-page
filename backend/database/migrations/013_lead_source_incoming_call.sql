-- Adds "Incoming call" to the lead source list.
--
-- A lead created from a customer who rang in is not a manual entry and is not "other":
-- it is the one source that arrives without anybody going looking for it, and a manager
-- who cannot see how many leads the phone brought in has no way to judge whether
-- answering it is worth staffing. The mobile app selects this slug automatically when a
-- lead is created from the Incoming calls screen.
--
-- `sort_order` 45 puts it between "Manual entry" (40) and "Hard copy" (50) rather than at
-- the end, because the list is ordered by how often a telecaller picks it and this will
-- outrank both. The existing rows keep their numbers, so nothing reorders.
--
-- INSERT ... ON DUPLICATE KEY UPDATE, matching the seed block in 006, so re-running this
-- against a database where an administrator has already created the source by hand
-- corrects its label instead of failing on the unique slug.
INSERT INTO lead_sources (slug, label, sort_order) VALUES
  ('incoming_call', 'Incoming call', 45)
ON DUPLICATE KEY UPDATE label = VALUES(label), sort_order = VALUES(sort_order);
