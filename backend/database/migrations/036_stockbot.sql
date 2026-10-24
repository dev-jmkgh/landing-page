-- =============================================================================
-- 036 — Opening-range breakout bot (modules/stockbot)
--
-- Each trading day the bot records every tracked stock's high and low between
-- 09:15:00 and 09:15:30 IST, freezes them as that day's levels, and reports the
-- first trade above the high and below the low. Everything it must remember
-- across an API restart lives here: a deploy at noon reloads the levels and
-- carries on, because a 30-second window cannot be captured twice.
--
-- Rows are written only by the bot. Prices are rupees (the feed's paise / 100).
-- Times are UTC like every other DATETIME in this schema; trade_date is the IST
-- calendar day, bound as 'YYYY-MM-DD' and read back with DATE_FORMAT.
-- =============================================================================

-- One row per IST trading day the bot ran on.
--
-- runner_token and lease_expires_at give single ownership, as in report_runs:
-- the session that holds an unexpired lease is the only one that may write, and
-- a stopped process releases it so its successor can start at once. Without it
-- two processes would each open a market-data connection (Angel allows three)
-- and capture the same window twice.
CREATE TABLE IF NOT EXISTS stockbot_days (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  trade_date        DATE            NOT NULL,

  -- starting:   claimed, logging in and building the target list.
  -- capturing:  connected, recording the opening range.
  -- monitoring: levels frozen, watching for breakouts until the close.
  -- closed / no_data / missed / failed are final for the day:
  --   no_data  no tracked stock traded in the window (a holiday, or no feed);
  --   missed   started after the window with no levels saved;
  --   failed   a problem retrying cannot fix today (bad credentials, no targets).
  status            ENUM('starting','capturing','monitoring','closed','no_data','missed','failed')
                    NOT NULL DEFAULT 'starting',
  attempts          SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  target_count      SMALLINT UNSIGNED NULL,
  levels_ok         SMALLINT UNSIGNED NULL,
  levels_missing    SMALLINT UNSIGNED NULL,
  -- A sentence composed by the service. Never an API response body.
  last_error        VARCHAR(255)    NULL,

  runner_token      CHAR(36)        NULL,
  runner_label      VARCHAR(120)    NULL,
  lease_expires_at  DATETIME        NULL,

  started_at        DATETIME        NULL,
  frozen_at         DATETIME        NULL,
  finished_at       DATETIME        NULL,
  -- At-most-once for the morning levels email and the one "today did not run"
  -- notice, whichever processes and restarts are involved.
  levels_emailed_at DATETIME        NULL,
  notice_emailed_at DATETIME        NULL,

  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_stockbot_days_date (trade_date)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- The frozen levels: one row per tracked instrument per day, including the ones
-- that did not trade in the window (status no_data), so the morning email and
-- any later screen can say which stocks were not watched and why.
CREATE TABLE IF NOT EXISTS stockbot_levels (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  trade_date   DATE            NOT NULL,
  exchange     ENUM('NSE','BSE') NOT NULL,
  -- Angel's instrument token. Up to 25 characters on the wire.
  token        VARCHAR(25)     NOT NULL,
  symbol       VARCHAR(64)     NOT NULL,
  -- 'holdings', 'watchlist:<name>', comma-separated: why it was tracked.
  sources      VARCHAR(500)    NOT NULL,
  status       ENUM('ok','no_data') NOT NULL,
  range_high   DECIMAL(14,2)   NULL,
  range_low    DECIMAL(14,2)   NULL,
  open_price   DECIMAL(14,2)   NULL,
  -- Exchange time of the last packet inside the window, the one the range came from.
  packet_at    DATETIME(3)     NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_stockbot_levels_day_instrument (trade_date, exchange, token)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- The first break of each level. The unique key is the alert's idempotency: a
-- restarted session that sees the same break again inserts nothing, so nobody
-- is told twice.
--
-- alert_claim marks rows a flush has taken; alerted_at marks them settled. A
-- failed send clears the claim so the next flush retries.
CREATE TABLE IF NOT EXISTS stockbot_breakouts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  trade_date      DATE            NOT NULL,
  exchange        ENUM('NSE','BSE') NOT NULL,
  token           VARCHAR(25)     NOT NULL,
  symbol          VARCHAR(64)     NOT NULL,
  direction       ENUM('up','down') NOT NULL,
  level_price     DECIMAL(14,2)   NOT NULL,
  -- The day high (up) or low (down) that crossed the level. It can be beyond the
  -- last traded price: a spike between two packets still counts.
  breakout_price  DECIMAL(14,2)   NOT NULL,
  last_price      DECIMAL(14,2)   NOT NULL,
  -- Exchange time of the packet that first showed the break.
  detected_at     DATETIME(3)     NOT NULL,
  alert_claim     CHAR(36)        NULL,
  alerted_at      DATETIME        NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_stockbot_breakouts_once (trade_date, exchange, token, direction),
  -- The alert flush: today's rows nobody has claimed yet.
  KEY idx_stockbot_breakouts_alert (trade_date, alert_claim)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
