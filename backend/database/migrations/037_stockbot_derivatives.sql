-- =============================================================================
-- 037 — Stock bot: futures and options contracts
--
-- A watchlist entry may now name an NSE or BSE derivative contract
-- (NFO:..., BFO:...) as well as a stock, so the levels and breakouts can be for
-- those segments too. Appending values to the end of an ENUM changes no stored
-- row and needs only the ALTER privilege the application user already has.
-- =============================================================================

ALTER TABLE stockbot_levels
  MODIFY exchange ENUM('NSE','BSE','NFO','BFO') NOT NULL;

ALTER TABLE stockbot_breakouts
  MODIFY exchange ENUM('NSE','BSE','NFO','BFO') NOT NULL;
