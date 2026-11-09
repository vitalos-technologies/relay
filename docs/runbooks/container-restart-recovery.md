# Container or host restart recovery

Audience: operators of a self-managed host (and of the shared development host). Repo only. Reviewed 2026-11-09
(product 2026-11). Background: `HANDOFF.md` (environment notes), `docs/v5-progress/STREAM_BRIEFING.md` (shared host).

**Affected resources:** Docker daemon and the compose services (PostgreSQL, storage, identity provider, mail capture
in development), the `web` and `worker` processes, pid files in `.data/`, in-flight deliveries.

## Symptoms

- After a host or container restart, `docker info` fails or `dockerd` refuses to start because of an existing pid file.
- `curl -s localhost:3000/api/ready` or the worker `:3001/health` does not answer; `.data/web.pid` / `.data/worker.pid`
  point at processes that no longer exist.
- The app answers but sign-in hangs (an old web server process still serving a previous build).

## Diagnostics (READ-ONLY)

```bash
docker info >/dev/null 2>&1 && echo "docker up" || echo "docker down"
cat /var/run/docker.pid 2>/dev/null && ps -p "$(cat /var/run/docker.pid)" >/dev/null 2>&1 && echo "pid alive" || echo "pid stale or missing"
docker compose -f infra/compose.yaml ps
for f in .data/web.pid .data/worker.pid; do [ -f "$f" ] && (ps -p "$(cat $f)" >/dev/null && echo "$f alive" || echo "$f stale"); done
curl -s localhost:3000/api/ready; curl -s localhost:3001/health
```

## Corrective actions

1. **Docker will not start because of a stale pid file.** If `/var/run/docker.pid` exists and the process it names is
   **not running**, remove **only that file**, then start the daemon:
   **DESTRUCTIVE (limited)** `rm /var/run/docker.pid` — only after confirming the pid is dead; never remove it while
   `dockerd` runs. Then start `dockerd` (service manager, or `dockerd` in the background on a bare container).
2. Start the services: `docker compose -f infra/compose.yaml up -d --wait`. Volumes keep the data; do not run
   `docker compose down -v` (**DESTRUCTIVE**: deletes the database and storage volumes).
3. Start the worker, then the web app (on the shared development host, under the lock:
   `flock -o .data/devserver-v2.lock …`, with `3>&- 9>&-` when backgrounding). Before starting web, make sure no old
   `next-server` holds port 3000 and that the stale pid files are replaced.
4. Migrations: only if the release changed (`pnpm db:migrate` then `pnpm db:roles`); a restart alone needs none.

## What happens to publishing across a restart

- Deliveries that were being **prepared** return to Scheduled after their 90-second lease expires and resume from
  their checkpoint.
- Deliveries that were **sending** become **Unknown** and are reconciled read-only; they are never resent
  automatically ([failed-and-ambiguous-publications.md](failed-and-ambiguous-publications.md)).
- Deliveries whose publish-before deadline passed while everything was down become **Expired** (never sent late).
- Outbox rows and pg-boss jobs are durable in PostgreSQL; nothing queued is lost.

## Verification

- `/api/ready` → ready; worker `/ready` → ready with recent `lastRun` entries; a fresh `worker_heartbeats` row.
- `/admin/operations`: overdue work drains; review any new Unknown deliveries.

## Escalation

Docker data directory or volume errors (filesystem corruption), PostgreSQL refusing to start, or missing data after
the restart: stop, do not reinitialise volumes, escalate (and see
[backup-restore-and-reconciliation.md](backup-restore-and-reconciliation.md)).
