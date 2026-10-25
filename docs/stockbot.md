# Opening-range breakout bot

Runs inside the API process (`backend/src/modules/stockbot/`). Every trading day it
takes the high and low each tracked stock trades between **09:15:00 and 09:15:30 IST**,
freezes them as that day's levels, and records when a stock first trades above its high
or below its low. It places no orders.

**Emails are off** unless `STOCKBOT_EMAILS=1` (the client asked for none). With them off,
the email steps below are skipped and the results are read on the status page or with
`status`.

## The status page

The trader has no account in any JMK app, so the page is a private link:
`https://api.jmkglobalholdings.com/api/stockbot/<STOCKBOT_VIEW_TOKEN>`. Anyone with the
link can read it; without it the address answers 404 like any unknown path. It shows the
day's state (live, closed, holiday, did not run), the breakouts newest first, and every
level, 50 rows a page, with a stock search and day-to-day links. Today's page reloads
itself every minute while the market is open. It is read-only and shows only the bot's
own output, never anything from the trading account.

Turn it on by adding a token to the server `.env` and restarting the API:

```
# printf, not echo: the leading \n keeps it off the last line if .env has no final newline
printf '\nSTOCKBOT_VIEW_TOKEN=%s\n' "$(openssl rand -hex 24)" | sudo tee -a /var/www/jmkglobalholdings/backend/.env > /dev/null
sudo systemctl restart jmk-global-backend
sudo grep '^STOCKBOT_VIEW_TOKEN=' /var/www/jmkglobalholdings/backend/.env   # the value for the link
```

To revoke a shared link, replace the value and restart.

Tracked stocks, rebuilt every morning with nothing to maintain:

- the Angel One account's holdings;
- every NSE F&O stock (about 210 — the underlyings of current stock futures, read from
  Angel's instrument list, so additions and removals follow the exchange);
- optionally, extra stocks listed in `watchlists.json`.

The client's own Angel One watchlists cannot be read: SmartAPI has no watchlist endpoint
and the app has no export. The F&O list stands in for them.

## A trading day

| IST | What happens |
|---|---|
| 09:00 | Scheduler claims the day, logs in (TOTP generated from the secret), downloads the instrument list, reads holdings and `watchlists.json`, opens the market feed |
| 09:15:00–09:15:30 | Records every packet stamped inside the window |
| 09:15:33 | Freezes and saves the levels; **email: "Opening range set for N stocks"** (first 60 in the body, all of them in `levels.csv`) |
| until 15:30 | **Email: "Breakout: …"** at most once a minute while new breaks arrive (first 40 in the body, the rest in `breakouts.csv`). Each level is reported once a day. |
| 15:30 | Closes the feed, logs out, marks the day `closed` |

Saturdays and Sundays are skipped. On an exchange holiday nothing trades in the window,
the day ends `no_data`, and one notice email says so.

## Setting it up on the server

1. Deploy as usual (`sudo /var/www/jmkglobalholdings/deploy/deploy.sh`). It applies
   migration 036, which adds `stockbot_days`, `stockbot_levels` and `stockbot_breakouts`.

2. Add the credentials to `/var/www/jmkglobalholdings/backend/.env`:

   ```
   ANGEL_CLIENT_ID=<client id>
   ANGEL_PIN=<MPIN>
   ANGEL_TOTP_SECRET=<base32 TOTP secret>
   ANGEL_API_KEY=<SmartAPI app key>
   ANGEL_STATIC_IPS=3.110.84.46
   ```

3. Optional — only for stocks outside holdings and F&O. The data directory defaults to
   `stockbot` next to `UPLOAD_DIR`, which on this server is inside the one directory the
   service may write:

   ```
   sudo -u jmk mkdir -p /var/www/jmkglobalholdings/storage/stockbot
   sudo -u jmk nano /var/www/jmkglobalholdings/storage/stockbot/watchlists.json
   ```

   ```json
   { "watchlists": { "Watchlist 1": ["RELIANCE", "TCS", "INFY"], "Banks": ["HDFCBANK", "BSE:SBIN"] } }
   ```

   A bare symbol means NSE (`STOCKBOT_PREFERRED_EXCHANGE`); prefix `BSE:` for BSE.
   Indices work by name (`NIFTY`). Futures and options are named by segment and Angel's
   exact trading symbol: `BFO:SENSEX26OCT73800CE`, `NFO:NIFTY27OCT2622700CE`. A contract
   stops resolving the day after it expires; the morning email then lists it under "Not
   tracked", which is the cue to update the file. The file is re-read every morning, so
   edits need no restart.

4. Test, then restart the API so it reads the new `.env`:

   ```
   cd /var/www/jmkglobalholdings/backend
   sudo -u jmk -H env NODE_ENV=production npm run stockbot:prod -- check
   sudo systemctl restart jmk-global-backend
   journalctl -u jmk-global-backend -n 50 --no-pager | grep -i "stock bot"
   ```

   The log should say `Stock bot: scheduler on`. There is nothing else to schedule.

## Commands

| Command (from `backend/`, as `jmk`) | |
|---|---|
| `npm run stockbot:prod -- check` | Logs in, reads holdings and watchlists, listens to the feed for 15 s, logs out. Writes nothing, sends nothing. Refused 09:00–15:35 on weekdays (a second login can disturb the live session) unless `--force`. |
| `npm run stockbot:prod -- status` | Today's day status, levels and breakouts, from the database. Add a date for another day. |

Prefix both with `env NODE_ENV=production` on the server. In development use
`npm run stockbot -- …` (runs from `src` with tsx).

## Rules that matter

- **Do not deploy between 09:10 and 09:16 IST.** A restart across 09:15:30 loses that
  day's opening range, and it cannot be rebuilt. A restart at any other time is safe:
  the new process resumes from the saved levels within a minute, and breaks during the
  gap are still caught, because the feed's day high and low include them.
- **A refused login stops the bot for the day** and sends one notice. Angel locks an
  account after repeated failed logins, so it never retries a wrong PIN. An invalid TOTP
  is retried once, with the next code. Keep the server clock synced
  (`timedatectl status` → "System clock synchronized: yes").
- **Orders, if ever added, work only from `ANGEL_STATIC_IPS`.** Login and market data
  work from anywhere. `check` prints whether this machine may place orders.
- **Feed limits:** 1,000 instruments per connection, three connections, so 3,000 at most.

## How the levels are measured

From Angel's SmartStream feed in SNAP_QUOTE mode, using the exchange's own day high and
low from the last packet stamped inside the window. The stream is snapshots, not every
trade, so this is more exact than the highest price we happen to receive. It includes
the opening price from the pre-open auction, as a broker's 09:15 candle does. A packet
counts only if its last trade was that morning: on a holiday the feed still sends
snapshots, carrying the previous session's prices. A stock that did not trade in the 30
seconds has no range and is not watched that day; the morning email lists them.

## Troubleshooting

| Log line / email | Meaning |
|---|---|
| `Stock bot: not configured` | One or more `ANGEL_*` values missing. |
| `Stock bot is configured but its settings are invalid` | The `problems` list names the variable. |
| Notice "no market data this morning" | Holiday, or the feed did not connect before 09:15:30. |
| Notice "no breakout alerts today" | The API was down or restarting at 09:15. |
| Notice "Angel One refused the login" | Wrong credentials; nothing more happens that day. |
| `lost the day lease to another process` | Two API processes share the database; only one trades a day. |
