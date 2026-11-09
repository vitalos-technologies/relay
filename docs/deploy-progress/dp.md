# Stream DP — production deployment kit for the shared Oracle VM

Status: **kit built; full kit test 43/43 on amd64 and 43/43 with arm64 images under QEMU in the sandbox**. Not run on the VM.
Owner files (new): `infra/oracle/**`, `docs/runbooks/oracle-vm-deployment.md`, this note. Edited shared:
`docs/FINAL_ACTIVATION_CHECKLIST.md` (§0.3 and §1 rows only). Not touched: product code, `infra/docker/Dockerfile`,
`scripts/build-images.sh`, dev `infra/compose.yaml`.

## Decisions

- **Three hostnames from one variable** (`--domain`, default `relay.vitalos.co.uk`): app, `auth.<domain>` (Keycloak on
  its own origin, checklist 2.1) and `media.<domain>` (S3 presigned URLs sign the Host, so path-prefix proxying would
  break signatures). DNS: three A records or one A + wildcard.
- **Two root-only env files**: `.env.infra` (compose interpolation: DB/Keycloak/S3/OIDC secrets, ports, tag) and
  `.env.production` (web + worker only: `SESSION_SECRET`, `KEY_ENCRYPTION_KEYS`, activation variables commented out).
  Web never sees the DB superuser or Keycloak admin passwords. Empty `VAR=` lines are avoided on purpose (zod treats
  `''` as a value; e.g. `S3_PUBLIC_ENDPOINT=` would fail URL validation).
- **Keycloak production mode**: `start --import-realm`, `KC_PROXY_HEADERS=xforwarded`, own DB in the same Postgres,
  `KC_CACHE=local`. Realm template `infra/oracle/keycloak/relay-realm.json` generated from the reference realm by
  `make-prod-realm.py`: realm `relay`, client `relay-web`, **no users** (service account only), secret / URLs / RP ID
  as `${ENV}` placeholders resolved at first import, `sslRequired=all`, password policy, SMTP empty, self-registration
  `${RELAY_SELF_REGISTRATION:false}` (D26 switchable). Back-channel logout goes to `http://web:3000` on the private
  network. Admin console and master realm are **404 on the public host**; admin via SSH tunnel to 127.0.0.1:3380
  (`KC_HOSTNAME_ADMIN`).
- **Hairpin-free**: web/worker resolve the public names to `host-gateway` (`extra_hosts`), so OIDC discovery/token calls
  go through the VM's own proxy with the real certificate; no dependence on OCI hairpin NAT.
- **Release job image** `relay-migrate` = worker image + bundled `db-roles` / `platform-operator` CLIs (esbuild, no tsx)
  + `ensure-bucket.mjs` (production Relay never creates its bucket). Runs roles → migrations (migrator role) → grants →
  bucket. Same layers as the worker (+~1 MB).
- **HSTS** comes from `next.config.ts` at *build* time, so the Dockerfile builds web with `APP_ENV=production`
  (verified: header present).
- **Backups**: age, public key only on the VM; private key shown once (or written to a file with
  `--backup-identity-out`). Every stream is encrypted inside a `--network none` alpine+age container; plaintext never
  hits the disk. Media: storage container paused (not stopped) during tar. Realm export via a short-lived second JVM.
  Config files included (KEKs needed to decrypt stored credentials, checklist 13.3).
- **SeaweedFS disk**: measured that it reserves `volumeSizeLimitMB × growth` on the first write (1024 MB × 7 = 7.1 GB with
  the earlier settings). Kit uses 256 MB × 2 (≈ 0.5 GB). (Observation for the lead: the dev volume `social-lite_s3data`
  holds 5.3 GB for the same reason.)
- **SMTP**: `assertProductionSafe` refuses to start without `SMTP_URL` (the brief assumed "shows not configured").
  Bootstrap therefore stops before web/worker until it is set, or `--allow-no-smtp` writes the unresolvable placeholder
  `smtp://email-not-configured.invalid:587` (boots; every email fails visibly; Diagnostics shows SMTP failing; the setup
  overview still lists email as configured because a value is present). Product decision for a fix stream: allow an
  explicit "email disabled" mode, or keep it required.

## What was tested (sandbox: x86_64, Docker 29.9, compose 5.6, 4 CPU / 16 GB)

`infra/oracle/test/local-test.sh dp-amd64` (project `relay-dptest`, ports 13300/13380/13333 + Caddy on 18080/8443 with
its local CA, domain `relay-dp.test`): see the run log summary in "Results" below. It runs the real scripts:
bootstrap dry run + `--apply` (bundled Caddy path, `--allow-no-smtp`), header/route checks through Caddy TLS, realm and
role checks, Playwright sign-in through production-mode Keycloak (test user created with kcadm, then
`/api/session` 200), `status.sh --operator grant`, `backup.sh` (6 encrypted files), `restore.sh --drill`, `update.sh`
to a new tag, `update.sh` to a deliberately broken web image (automatic rollback), `status.sh`, then full teardown
(containers, network, volumes, test dir).

Proxy detection/integration, separately (sandbox, test ports 18081/18444):
- host **nginx** (apt nginx): detected; `--apply` wrote `sites-available/relay.conf` + symlink, `nginx -t`, graceful
  reload; other site kept serving (200); `/admin` 404 on auth host; HTTP→HTTPS redirect; re-run idempotent ("unchanged");
  invalid certificate → `nginx -t` failed → file rolled back from backup, nginx not reloaded.
- host **Caddy** (apt caddy): detected; `relay.caddy` written + one `import` line appended (diff + backup shown);
  `caddy validate`; reload; other site kept serving; HTTP 308 to HTTPS for the Relay name.
- **Traefik in Docker**: detected container, network, entrypoint (`websecure`) and resolver (`le`) from its args;
  generated `compose.override.yaml` (labels + external network) merges correctly (`docker compose config`); warns when
  the Docker provider flag is absent.
- **free 80/443** → bundled Caddy (used by the full test).
- Not exercised: Apache (renderer only), Traefik on the host (renderer only), `--run-certbot` (needs public DNS).
- Cleanup: sandbox nginx/caddy stopped, their Relay files removed.

`shellcheck -x -S warning` clean on all scripts.

## Architectures

- amd64: built natively (bake, ~4 min warm) and tested end to end (above).
- arm64: QEMU binfmt registered in the sandbox (Docker Hub was rate-limited, so `qemu-user-static` from apt, registered
  with the `F` flag). Built with `build.sh --platform linux/arm64` in 26–29 min under emulation (native Ampere will be
  far faster). Images verified `linux/arm64`, uid 10001, `uname -m` = aarch64, sharp (libvips 8.18.7) loads, ffprobe
  5.1.9 present. The **whole kit test ran with the arm64 app images** (emulated; Postgres/Keycloak/SeaweedFS/Caddy
  native multi-arch images): 43/43. Not yet run on real Ampere hardware.
- Compressed image sizes (arm64): web 128 MB, worker 272 MB, migrate = worker + ~5 KB. Worker is large because of
  Debian's ffmpeg (472 MB unpacked).

## Results

| Run | Images | Result |
|---|---|---|
| `local-test.sh dp-amd64` (fresh, teardown) | amd64 native | **43 passed, 0 failed** |
| `local-test.sh dp-arm64` (fresh, teardown) | arm64 under QEMU | **43 passed, 0 failed** |

The 43 checks: dry run (detection, no changes); apply; env files 0600; no secret printed; `/api/ready` on loopback;
only 127.0.0.1 bindings except Caddy; Postgres unpublished; through Caddy TLS: `/api/ready`, CSP nonce, HSTS,
`X-Frame-Options: DENY`, `/help`, `/marketing/overview-light.webp` (1.13), OIDC discovery issuer, `/admin` and
`/realms/master` 404 publicly, admin console on loopback; media host answers (anonymous 403); realm: no people,
registration off, `sslRequired=ALL`, generated client secret, redirect URI from the domain; web as `socialite_app`,
worker as `socialite_worker`, no privileged role attributes; bootstrap re-run keeps every secret, keeps the proxy mode,
ends ready; Playwright sign-in through production-mode Keycloak (`/api/session` 200); Keycloak admin console login on
the loopback port (SSH-tunnel path); `status.sh --operator grant`; fresh media volume 513 MB; backup with 6 encrypted
files (age header); restore drill complete with dispatch forced off and no leftover container; `update.sh` to a new tag
with pre-release backup; `update.sh` to a broken web image → automatic rollback (≈4 min, then healthy), tag restored,
ready; `status.sh` ready.

Measured on the test stack (idle): web 110 MB, worker 74 MB, Keycloak 580 MB, Postgres 133 MB, SeaweedFS 30 MB,
Caddy 12 MB. Full backup of a fresh install: ~35 s, 1.6 MB. Restore drill: ~10 s.

Bugs found and fixed by the runs: hairpin/OIDC CA trust in the test overlay; Keycloak admin console used the public
host for the master realm (fixed: bootstrap sets the master realm Frontend URL to `http://localhost:<auth port>`);
SeaweedFS 7 GB preallocation; nginx conflict check flagged our own file; timestamped generated files broke
idempotency; IPv6 `listen` lines on hosts without IPv6; image pruning deleted never-deployed images (now only
previously deployed tags beyond the newest three).

Sandbox side effects (cleaned): nginx and caddy apt packages installed for the proxy tests, then purged; test images,
containers, networks and volumes removed; build cache pruned. Left in place: `qemu-user-static`, `binfmt-support`,
`shellcheck` packages and the `qemu-aarch64` binfmt registration (needed for any later arm64 build here).
Logs: scratchpad `dp/test6.log` (amd64), `dp/test8.log` (arm64); screenshots `dp/shots-arm64/`.

## Next / for the user

See the runbook. Decisions/inputs: domain (default), DNS records, OCI security list 80/443, SMTP provider (587/465),
store the backup key, optional off-VM rsync target, Keycloak admins with MFA, self-registration on/off (D26).
