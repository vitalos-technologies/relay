#!/bin/sh
# One-shot release job (the "migrate" image's default command). Idempotent; safe to re-run.
#   1. least-privilege login roles + grants (owner connection, DATABASE_ADMIN_URL)
#   2. migrations as socialite_migrator (MIGRATOR_DATABASE_URL), checksum-verified
#   3. grants again (covers objects the migrations just created)
#   4. private media bucket + CORS (production Relay never creates buckets itself)
# Prints no secrets: only the JSON status lines of each step.
set -eu
cd /app
node ops/db-roles.mjs
node dist/migrate.mjs migrate
node ops/db-roles.mjs
node ops/ensure-bucket.mjs
echo '{"msg":"release job complete"}'
