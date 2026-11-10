# Relay on one shared VM (Oracle Ampere arm64)

Production kit: Relay, PostgreSQL 16, SeaweedFS (media), Keycloak 26.4 (production mode) and, only when ports 80/443
are free, a bundled Caddy. Everything stays on the VM in Docker project `relay`; app ports bind to `127.0.0.1`.
Step-by-step guide for the operator: [`docs/runbooks/oracle-vm-deployment.md`](../../docs/runbooks/oracle-vm-deployment.md).

| File | Purpose |
|---|---|
| `bootstrap.sh` | First install / safe re-run. Dry run by default; `--apply` to change things. Detects nginx / Caddy / Traefik / Apache / free ports and integrates without touching other sites; generates secrets on the VM |
| `update.sh` | Release: backup → release job → worker → web → health; automatic rollback to the previous tag. Also `--restart`, `--rollback` |
| `status.sh` | Health, versions, resources, backups, TLS; `--logs`, `--operator` (platform operators), `--psql` |
| `backup.sh` | Encrypted (age) nightly backup: Relay + Keycloak databases, roles, realm export, media, settings. Rotation |
| `restore.sh` | `--drill` (isolated, nothing live touched), `--promote` (live restore, dispatch forced off), `--extract-config`, `--start-worker` |
| `build.sh`, `docker-bake.hcl`, `Dockerfile` | Multi-arch images `relay-web`, `relay-worker`, `relay-migrate` (non-root, healthchecks, `public/` and `content/help` included) |
| `compose.prod.yaml` | The stack: limits, restart policies, log rotation, private network, loopback-only ports |
| `keycloak/relay-realm.json` | Production realm template (no users or passwords; passwordless sign-in, D34; placeholders filled from the VM's env on first import). Regenerate with `keycloak/make-prod-realm.py` when the reference realm changes |
| `admin.sh` | Keycloak helpers: `replace-bootstrap`; `passwordless` (switch an existing realm to email link + code, Google ready; refuses without realm SMTP; `--undo`); `google-signin` (Google OAuth client, hidden secret prompt). Secrets via hidden prompts → stdin only |
| `keycloak/realm-admin.mjs` | The Admin-REST helper `admin.sh passwordless` / `google-signin` run (in the web image, next to Keycloak) |
| `../keycloak/Dockerfile` | Sign-in server image `relay-keycloak:local` (Keycloak 26.4 + keycloak-magic-link 0.52, sha256-pinned + `relay-auth` provider + Relay theme); built by `update.sh` |
| `postgres/10-keycloak.sh` | Creates Keycloak's role and database on the first start |
| `ops/` | Release job (`release.sh`: roles → migrations → grants → media bucket) and bundled operator CLIs |
| `proxy/Caddyfile.bundled` | Bundled Caddy site config (three Relay hostnames) |
| `systemd/` | `relay-backup.service` / `.timer` (nightly) |
| `tools.Dockerfile` | Tiny alpine + age image for backups (always run without network) |
| `test/local-test.sh` | Self-test of the whole kit on a dev machine under another project name and ports; tears down after |

Files on the VM (all created by `bootstrap.sh --apply`):

| Path | Contents |
|---|---|
| `/opt/relay/.env.infra` (0600) | Domain, ports, image tag, generated database/Keycloak/storage/OIDC secrets |
| `/opt/relay/.env.production` (0600) | App settings for web + worker: generated `SESSION_SECRET`, `KEY_ENCRYPTION_KEYS`, `RELAY_PLATFORM_STATUS_TOKEN` (web only; added to an existing file if absent); activation variables listed unset |
| `/opt/relay/secrets/s3.json` (0600) | SeaweedFS identity |
| `/opt/relay/backup/recipient.txt` | Backup public key (the private key was shown once and is not on the VM) |
| `/opt/relay/backups/` | Encrypted backups; `proxy/` holds copies of any proxy file the kit changed |
| `/opt/relay/compose.override.yaml` | Only for Traefik-in-Docker / containerised proxies (network join) |

Build anywhere (arm64 on non-ARM machines needs QEMU binfmt):

```sh
infra/oracle/build.sh --platform linux/arm64 --tar relay-images.tar
```
