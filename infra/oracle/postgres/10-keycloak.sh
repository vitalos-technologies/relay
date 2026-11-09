#!/bin/sh
# First start of an empty data directory only (docker-entrypoint-initdb.d). Creates Keycloak's own role and database
# in the same cluster (one backup covers both). Relay's login roles are created by the release job (ops/release.sh).
set -eu
: "${KEYCLOAK_DB_PASSWORD:?KEYCLOAK_DB_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v kcpw="$KEYCLOAK_DB_PASSWORD" -v appdb="$POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE keycloak LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'kcpw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak') \gexec
SELECT 'CREATE DATABASE keycloak OWNER keycloak'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'keycloak') \gexec
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
-- Only Relay's own roles (granted by roles.sql) may connect to the Relay database.
REVOKE ALL ON DATABASE :"appdb" FROM PUBLIC;
SQL
