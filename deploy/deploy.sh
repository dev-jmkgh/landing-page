#!/usr/bin/env bash
# =============================================================================
# JMK Global Holdings — production update
#
#   sudo /var/www/jmkglobalholdings/deploy/deploy.sh
#
# Pulls the latest commit, rebuilds both sides, applies pending migrations,
# restarts the API and verifies it answers before declaring success.
#
# It never touches backend/.env or frontend/.env.production. Those hold the
# production secrets, they live only on this server, and a deploy that
# overwrote them would take the site down and leak nothing useful in exchange.
#
# It also never copies the Nginx configs. Certbot rewrote the installed files
# to add the TLS blocks; copying the repo versions over them would delete that
# and drop the site back to plain HTTP. Nginx changes are applied by hand.
# =============================================================================
set -Eeuo pipefail

ROOT="${ROOT:-/var/www/jmkglobalholdings}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-jmk-global-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5000/api/health}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m  ! \033[0m%s\n' "$1"; }
fail() { printf '\n\033[1;31mFAILED:\033[0m %s\n' "$1" >&2; exit 1; }

cd "$ROOT" || fail "deploy root $ROOT not found"

# --- Who owns the checkout ---------------------------------------------------
# The tree belongs to the service account, not to whoever is running this. Build
# steps must write as that owner or npm and git fail on permissions, and any file
# they did manage to create would be unreadable by the service afterwards.
APP_USER="$(stat -c '%U' "$ROOT/.git")"
[[ -n "$APP_USER" ]] || fail "cannot determine the owner of $ROOT/.git"

if [[ "$(id -un)" == "$APP_USER" ]]; then
  as_app() { "$@"; }
else
  command -v sudo >/dev/null || fail "not running as $APP_USER and sudo is unavailable"
  as_app() { sudo -u "$APP_USER" -H "$@"; }
fi

# systemctl and nginx need root; the build steps must not have it.
if [[ $EUID -eq 0 ]]; then
  as_root() { "$@"; }
else
  as_root() { sudo "$@"; }
fi

# --- Refuse to run without the production secrets present --------------------
# Building the frontend without frontend/.env.production would bake an empty API
# URL into the bundle and silently ship a site whose forms cannot submit.
[[ -f backend/.env ]] || fail "backend/.env is missing — production secrets are not on this server"
[[ -f frontend/.env.production ]] || fail "frontend/.env.production is missing — the build would have no API URL"

PREVIOUS="$(as_app git rev-parse --short HEAD)"

log "Fetching $BRANCH (building as $APP_USER)"
as_app git fetch --prune origin
as_app git checkout "$BRANCH"
as_app git reset --hard "origin/$BRANCH"

TARGET="$(as_app git rev-parse --short HEAD)"
if [[ "$PREVIOUS" == "$TARGET" ]]; then
  warn "already at $TARGET — rebuilding anyway so a half-finished previous run cannot linger"
else
  log "Updating $PREVIOUS -> $TARGET"
  as_app git --no-pager log --oneline "$PREVIOUS..$TARGET" | sed 's/^/    /'
fi

log "Building the API"
# One full install: the build needs typescript, which lives in devDependencies.
as_app npm --prefix backend ci
as_app npm --prefix backend run build
[[ -f backend/dist/server.js ]] || fail "backend build produced no dist/server.js"
# Drop the dev tree afterwards so the running service has only what it needs.
as_app npm --prefix backend prune --omit=dev

log "Applying database migrations"
# Forward-only and checksummed: already-applied files are skipped, and nothing
# here drops or truncates. There is no reset path in this runner by design.
as_app npm --prefix backend run db:migrate:prod

log "Building the website"
as_app npm --prefix frontend ci
as_app npm --prefix frontend run build
[[ -f frontend/out/index.html ]] || fail "frontend build produced no out/index.html"

log "Restarting $SERVICE"
as_root systemctl restart "$SERVICE"

log "Waiting for the API to answer"
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    log "API healthy after ${attempt}s"
    break
  fi
  if [[ $attempt -eq 20 ]]; then
    as_root journalctl -u "$SERVICE" -n 40 --no-pager || true
    fail "API did not become healthy — the log above will say why. The previous build is gone; \`git reset --hard $PREVIOUS\` and re-run to go back."
  fi
  sleep 1
done

log "Reloading Nginx"
as_root nginx -t
as_root systemctl reload nginx

log "Checking the site through Nginx"
for url in https://jmkglobalholdings.com/ https://api.jmkglobalholdings.com/api/health; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)"
  printf '    %-46s %s\n' "$url" "$code"
  [[ "$code" == "200" ]] || warn "expected 200 from $url"
done

log "Deployed $TARGET on $BRANCH"
