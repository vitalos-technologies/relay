#!/usr/bin/env bash
# Stop a detached dev run (worker + web) started by scripts/dev.sh --detach. Add --infra to stop Docker services (data kept).
cd "$(dirname "$0")/.."
for f in .data/worker.pid .data/web.pid; do
  if [ -f "$f" ]; then pid=$(cat "$f"); pkill -TERM -P "$pid" 2>/dev/null || true; kill -TERM "$pid" 2>/dev/null || true; rm -f "$f"; fi
done
if [[ "${1:-}" == "--infra" ]]; then docker compose -f infra/compose.yaml stop; fi
echo "stopped"
