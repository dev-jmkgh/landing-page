-- Marks a call the telecaller has written up, as distinct from one merely detected.
--
-- Incoming calls arrive on their own: the app reads them out of the Android call log and
-- saves them before anybody has looked at them. So a `calls` row no longer means "a
-- telecaller recorded this call" — it means "this call happened". The Incoming list has
-- to tell those apart to decide between offering "Add call record" and "View call
-- record", and without a column for it the question has no reliable answer: `followed_up`
-- already means something else (the employee dealt with it, perhaps by calling back), and
-- inferring it from whether a note exists would call a recorded call with no note
-- unrecorded.
--
-- It also gives duplicate protection something to stand on. A second attempt to write up
-- the same call finds this set and edits the existing record instead of adding another,
-- which is the whole of the requirement — there is only ever one row per physical call,
-- so a duplicate is not something to detect and merge, it is something the schema does
-- not permit.
--
-- Nullable with no default, so every existing row reads as "not written up", which is
-- accurate: nothing before this migration went through that flow.
ALTER TABLE calls
  ADD COLUMN recorded_at TIMESTAMP NULL DEFAULT NULL AFTER followed_up;

-- Finding the calls still waiting to be written up is the Incoming list's default view,
-- and it is asked on every app resume. Narrow deliberately: the query is always scoped to
-- one telecaller's own incoming calls.
CREATE INDEX idx_calls_unrecorded ON calls (user_id, direction, recorded_at);
