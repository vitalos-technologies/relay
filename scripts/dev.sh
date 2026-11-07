#!/usr/bin/env bash
# One-command local startup: infrastructure, migrations, demo seed, worker and web.
# Usage: ./scripts/dev.sh            (foreground; Ctrl+C stops worker and web)
#        ./scripts/dev.sh --detach   (background; logs in .data/logs, stop with ./scripts/stop.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker (or dockerd) and retry." >&2
  exit 1
fi
[ -f .env ] || { echo "No .env found. Copy .env.example to .env and fill in local values (see README)." >&2; exit 1; }
[ -d node_modules ] || pnpm install --frozen-lockfile

set -a; . ./.env; set +a
export NEXT_TELEMETRY_DISABLED=1

echo "▸ Starting infrastructure (Postgres, S3 storage, OIDC, mail)…"
docker compose -f infra/compose.yaml up -d --wait

echo "▸ Database roles (migrator / app / worker, least privilege)…"
pnpm -s db:roles

echo "▸ Applying migrations (as the migrator role)…"
pnpm -s db:migrate
pnpm -s db:roles

echo "▸ Seeding synthetic demo data (skipped if present)…"
pnpm -s db:seed

echo "▸ Building worker…"
(cd apps/worker && node build.mjs >/dev/null)

mkdir -p .data/logs
ln -sf ../../.env apps/web/.env.local

if [[ "${1:-}" == "--detach" ]]; then
  DATABASE_URL="${WORKER_DATABASE_URL:-$DATABASE_URL}" nohup node apps/worker/dist/main.mjs > .data/logs/worker.log 2>&1 & echo $! > .data/worker.pid
  (cd apps/web && nohup npx next dev --webpack --port 3000 > "$ROOT/.data/logs/web.log" 2>&1 & echo $! > "$ROOT/.data/web.pid")
  for i in $(seq 1 90); do curl -sf localhost:3000/api/ready >/dev/null 2>&1 && break; sleep 2; done
  curl -sf localhost:3000/api/ready >/dev/null && echo "✔ Social Lite is running at http://localhost:3000 (sign in: owner@demo.social-lite.test / socialite-demo)" \
    || { echo "Web did not become ready; see .data/logs/web.log" >&2; exit 1; }
  echo "  Mail capture: http://localhost:8025 · Worker health: http://localhost:3001/health · Stop: ./scripts/stop.sh"
else
  DATABASE_URL="${WORKER_DATABASE_URL:-$DATABASE_URL}" node apps/worker/dist/main.mjs & WORKER=$!
  trap 'kill $WORKER 2>/dev/null || true' EXIT
  echo "✔ Open http://localhost:3000 (sign in: owner@demo.social-lite.test / socialite-demo)"
  cd apps/web && npx next dev --webpack --port 3000
fi
