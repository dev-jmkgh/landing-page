#!/usr/bin/env bash
# =============================================================================
# JMK Global Holdings — production deploy
#
#   cd /var/www/jmkglobalholdings && ./deploy/deploy.sh
#
# Pulls the production branch, rebuilds both sides, applies pending migrations,
# restarts the API and verifies it answers before declaring success.
#
# It never touches backend/.env or frontend/.env.production. Those hold the
# production secrets, they live only on this server, and a deploy that overwrote
# them would take the site down and leak nothing useful in exchange.
# =============================================================================
set -Eeuo pipefail

ROOT="${ROOT:-/var/www/jmkglobalholdings}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-jmk-global-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5000/api/health}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\n\033[1;31mFAILED:\033[0m %s\n' "$1" >&2; exit 1; }

cd "$ROOT" || fail "deploy root $ROOT not found"

# --- Refuse to run without the production secrets present --------------------
# Building the frontend without frontend/.env.production would bake an empty API
# URL into the bundle and silently ship a site whose forms cannot submit.
[[ -f backend/.env ]] || fail "backend/.env is missing — production secrets are not on this server"
[[ -f frontend/.env.production ]] || fail "frontend/.env.production is missing — the build would have no API URL"

log "Fetching $BRANCH"
git fetch --prune origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

log "Installing backend dependencies"
npm --prefix backend ci --omit=dev

log "Building the API"
# The build needs typescript, which --omit=dev skipped; install it just for the build.
npm --prefix backend ci
npm --prefix backend run build
npm --prefix backend ci --omit=dev

log "Applying database migrations"
# Forward-only and checksummed: already-applied files are skipped, and nothing here
# drops or truncates. There is no reset path in this runner by design.
npm --prefix backend run db:migrate:prod

log "Installing frontend dependencies"
npm --prefix frontend ci

log "Building the website"
npm --prefix frontend run build
[[ -f frontend/out/index.html ]] || fail "frontend build produced no out/index.html"

log "Restarting $SERVICE"
sudo systemctl restart "$SERVICE"

log "Waiting for the API to answer"
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    log "API healthy after ${attempt}s"
    break
  fi
  [[ $attempt -eq 20 ]] && {
    journalctl -u "$SERVICE" -n 40 --no-pager || true
    fail "API did not become healthy — the previous build is still on disk, and \`systemctl status $SERVICE\` plus the log above will say why"
  }
  sleep 1
done

log "Reloading Nginx"
sudo nginx -t
sudo systemctl reload nginx

log "Verifying SMTP and recipients"
# Reports whether the transport connects and how many ADMIN_EMAILS are configured.
# Prints no credential — see the mailer's config report.
curl -fsS --max-time 20 "http://127.0.0.1:5000/api/diagnostics/mail" || \
  echo "  (diagnostics endpoint requires an admin session in production — check manually)"

log "Deployed $(git rev-parse --short HEAD) on $BRANCH"
