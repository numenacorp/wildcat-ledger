#!/usr/bin/env bash
#
# Brings up a local Ledger: the Compose stack, the database migrations, the
# server, and one platform user. Prints what a client needs to connect.
#
#   scripts/local-up.sh            start everything
#   scripts/local-up.sh --stop     stop the server (the stack keeps running)
#
# Requires a built server (pnpm run build:server) and packages/server/.env.
# A build made while the server runs takes effect when this is run again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/packages/server"
RUN_DIR="$ROOT/.local"
PORT="${PORT:-$(grep -E '^PORT=' "$SERVER/.env" | cut -d= -f2 || true)}"
PORT="${PORT:-13000}"
API="http://localhost:$PORT/api"
EMAIL="${LEDGER_PLATFORM_EMAIL:-platform@ledger.local}"
PASSWORD="${LEDGER_PLATFORM_PASSWORD:-ledger-local-password}"

mkdir -p "$RUN_DIR"

stop_server() {
  if [ -f "$RUN_DIR/server.pid" ] && kill -0 "$(cat "$RUN_DIR/server.pid")" 2>/dev/null; then
    kill "$(cat "$RUN_DIR/server.pid")"
    echo "Server stopped."
  fi
  rm -f "$RUN_DIR/server.pid"
}

if [ "${1:-}" = "--stop" ]; then
  stop_server
  exit 0
fi

echo "==> Starting the stack"
(cd "$ROOT" && docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --wait mariadb redis redis-test gotenberg s3)

echo "==> Running migrations"
(cd "$SERVER" && node dist/cli.js system:migrate:latest && node dist/cli.js tenants:migrate:latest)

echo "==> Starting the server on port $PORT"
stop_server
# The server runs from a copy of the build, so that building again while it
# runs does not pull its files out from under it.
rm -rf "$SERVER/.live"
cp -a "$SERVER/dist" "$SERVER/.live"
(cd "$SERVER" && exec env NODE_ENV=production nohup node .live/main > "$RUN_DIR/server.log" 2>&1 < /dev/null) &
echo $! > "$RUN_DIR/server.pid"

for _ in $(seq 1 60); do
  if curl -sf "$API/system_db" > /dev/null; then break; fi
  sleep 2
done
curl -sf "$API/system_db" > /dev/null || { echo "The server did not start; see $RUN_DIR/server.log" >&2; exit 1; }

echo "==> Ensuring the platform user"
SIGNIN=$(curl -s -X POST "$API/auth/signin" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
if ! printf '%s' "$SIGNIN" | grep -q access_token; then
  curl -sf -X POST "$API/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"firstName\":\"Platform\",\"lastName\":\"User\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" > /dev/null
fi

cat <<INFO

Ledger is running.

  LEDGER_URL=$API
  LEDGER_EMAIL=$EMAIL
  LEDGER_PASSWORD=$PASSWORD

Server log: $RUN_DIR/server.log
INFO
