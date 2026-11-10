# Deploy Relay on the shared Oracle VM

Audience: the person who runs the VM. Repo only. Written 2026-11-09 for the kit in `infra/oracle/`.
Related: [deployment-and-configuration.md](deployment-and-configuration.md),
[backup-restore-and-reconciliation.md](backup-restore-and-reconciliation.md),
[migration-and-rollback.md](migration-and-rollback.md),
[keycloak-and-self-registration.md](keycloak-and-self-registration.md).

> **Status:** the kit was tested end to end on a throwaway copy of the stack in the build sandbox (see
> `docs/deploy-progress/dp.md` for exactly what ran, and on which architecture). It has **not** been run on your VM yet.
> Every step below starts with a dry run that changes nothing.

## What you get

Everything runs on your VM, in its own Docker project called `relay`, next to whatever else the VM already runs.

| Piece | What it is | Where its data lives |
|---|---|---|
| `web` | The Relay app | — |
| `worker` | Background jobs (publishing, imports, video) | — |
| `postgres` | PostgreSQL 16: the Relay database and Keycloak's database | Docker volume `relay_pgdata` |
| `storage` | SeaweedFS, S3-compatible storage for media | Docker volume `relay_media` |
| `keycloak` | Sign-in, two-step verification, passkeys | In `postgres` |
| `caddy` | Only if nothing else uses ports 80/443: HTTPS for the Relay names | Docker volume `relay_caddy_data` |

- Three web addresses, all from one setting (default `relay.vitalos.co.uk`):
  - `relay.vitalos.co.uk` — the app
  - `auth.relay.vitalos.co.uk` — sign-in
  - `media.relay.vitalos.co.uk` — media links that browsers and social networks fetch
- The app containers listen on `127.0.0.1` only (ports 3300, 3380, 3333). Nothing is reachable from the internet except
  through your reverse proxy. The database has no port on the host at all.
- Default memory limits: web 1 GB, worker 1.5 GB, Keycloak 1.2 GB, PostgreSQL 1 GB, storage 0.5 GB (typical use is
  about 1 GB in total when idle, measured on the test stack). CPU limits keep Relay from starving your other
  workloads. Media storage reserves disk in 0.5 GB steps. Logs rotate at 5 × 10 MB per
  container.
- Settings and secrets live in `/opt/relay/` in two root-only files. They are generated on the VM and never printed.

## Before you start (decide or provide)

1. **The domain.** Default `relay.vitalos.co.uk`. To use another one, add `--domain <name>` to every bootstrap command.
2. **DNS.** In your DNS provider for `vitalos.co.uk`, add three A records pointing at the VM's public IP:
   `relay`, `auth.relay` and `media.relay` (or `relay` plus a wildcard `*.relay`).
3. **Firewall.** In the Oracle Cloud console, the VM's security list (or network security group) must allow inbound
   TCP 80 and 443. If your other sites already work over HTTPS, this is done.
4. **Email (SMTP).** Relay refuses to start in production without `SMTP_URL`. You can start without it for a first
   look (`--allow-no-smtp`, explained in step 6), but sign-up emails, invitations and alerts only work once it is set.
   Oracle blocks outbound port 25: use your provider's port 587 or 465.
5. **A safe place for one key.** Step 6 shows a backup key once. Have your password manager open.
6. **Git access to the repository** from the VM (it is private).

## 1. Get the code onto the VM

Changes: creates `/opt/relay/src` only.

```sh
sudo mkdir -p /opt/relay
```

```sh
sudo git clone https://github.com/vitalos-technologies/relay.git /opt/relay/src
```

```sh
cd /opt/relay/src
```

## 2. Dry run

Changes: nothing. It checks the VM, finds out what serves ports 80 and 443, and prints exactly what `--apply` would do.

```sh
sudo infra/oracle/bootstrap.sh
```

Read section 3 of the output ("Who serves ports 80/443?"):

| It says | What `--apply` will do |
|---|---|
| free | Start Relay's own small Caddy container on 80/443 for the three Relay names only, with automatic HTTPS |
| nginx | Add one new file, `/etc/nginx/sites-available/relay.conf` (or `conf.d/relay.conf`), for the three names; test it with `nginx -t`; reload gracefully. Other sites are not touched |
| Caddy | Add `/etc/caddy/relay.caddy` and one `import` line at the end of your Caddyfile; validate; reload |
| Traefik | Write a Relay dynamic-config file (host Traefik) or join Traefik's Docker network with labels (Traefik in Docker) |
| Apache | Write `/etc/apache2/sites-available/relay.conf`; you enable it with the commands it prints |
| anything else | Change nothing; print the settings for your proxy |

If Docker is missing, it stops and tells you where to get it. It never installs software on the shared server.

## 2a. Shared VM: ports already in use

If the dry run stops because a port is taken, nothing has changed. Two common cases on a shared VM:

- **A loopback port is taken** (e.g. Grafana on 3300): choose free ones and pass them on every run (they're saved):
  `--web-port 3410 --auth-port 3480 --media-port 3433`. Check they're free first:

  ```sh
  sudo ss -ltn | grep -E ':(3410|3480|3433)\b' || echo free
  ```

- **443 is held by Tailscale on its own address** (`sudo ss -ltnp 'sport = :443'` shows `100.x.x.x%tailscale0:443`):
  Tailscale Serve/tailnet-only services keep working if Relay's HTTPS listens on the VM's normal private address
  instead of all addresses. Find it, then pass `--bind`:

  ```sh
  ip -4 -brief addr show | grep -v -E '^(lo|docker|br-|veth|tailscale)'
  ```

  e.g. `--bind 10.0.0.9`. Oracle's public IP is forwarded to that private address, so the site stays reachable. If
  `sudo tailscale funnel status` shows something published **publicly** (not "tailnet only") on 443, Relay and Funnel
  can't share it: decide which one owns public 443 first.

- **Little disk** (under 15 GB free): keep fewer nightly backups with `--backup-days 7` (never fewer than the 3 newest).

## 3. Install

Changes: everything listed in the dry run. Before it writes any existing file, it shows the difference and asks; it
keeps a copy of the old file in `/opt/relay/backups/proxy/<time>/`. Building the images takes 5–20 minutes and uses CPU
(at low priority).

```sh
sudo infra/oracle/bootstrap.sh --apply
```

Add `--domain <name>` if you are not using `relay.vitalos.co.uk`. Add `--allow-no-smtp` if email is not ready yet
(see step 6).

**The backup key.** During this step you see a block starting with `AGE-SECRET-KEY-`. It is shown **once** and is not
kept on the VM. Save it in your password manager, then type `stored`. Without it the backups cannot be restored.

## 4. HTTPS

- **Caddy (bundled or yours) and Traefik:** nothing to do. Certificates are issued once DNS points at the VM.
- **nginx or Apache:** once DNS resolves, run the certbot command the script printed. It looks like this:

```sh
sudo certbot certonly --webroot -w /var/www/relay-acme --cert-name relay -d relay.vitalos.co.uk -d auth.relay.vitalos.co.uk -d media.relay.vitalos.co.uk --deploy-hook 'systemctl reload nginx'
```

Then run bootstrap again. It switches the Relay file to full HTTPS (it shows the diff first):

```sh
sudo infra/oracle/bootstrap.sh --apply
```

## 5. Check

Changes: nothing.

```sh
sudo infra/oracle/status.sh
```

You want `web /api/ready 200`, `worker /ready 200`, `keycloak realm relay 200`, and the two public endpoints at 200.

## 6. Email

Edit the settings file (root only) and set `SMTP_URL` (and `EMAIL_FROM`) — the file explains the format:

```sh
sudo nano /opt/relay/.env.production
```

```sh
sudo infra/oracle/update.sh --restart
```

Started with `--allow-no-smtp`? That wrote a placeholder address that can never resolve: Relay runs, every email fails
and is logged as `email_send_failed`, and **Diagnostics** shows the SMTP check failing. (The setup overview may still
list email as configured, because a value is present.) Replace it before inviting anyone.

## 7. Keycloak administration (private)

**Shortcut:** replace the temporary `bootstrap-admin` with your own admin in one command (prompts for username, email
and password; creates and verifies the new admin before deleting the old one; requires two-step sign-in at your first
console login):

```sh
sudo /opt/relay/src/infra/oracle/admin.sh replace-bootstrap
```

The admin console is not on the public address. Open an SSH tunnel from your own computer:

```sh
ssh -L 3380:127.0.0.1:3380 <your user>@<your VM>
```

Read the one-time admin password on the VM:

```sh
sudo grep '^KC_BOOTSTRAP_ADMIN_PASSWORD=' /opt/relay/.env.infra
```

Then, in your browser on your computer, open `http://localhost:3380/admin/` and sign in as `bootstrap-admin`:

1. In the **master** realm, create your own administrator, give it the `admin` role and set up two-step verification.
   Sign in as that user, then delete `bootstrap-admin`. Have a second administrator (checklist 2.10).
2. Switch to the **relay** realm → **Realm settings → Email**: enter the SMTP details and **Test connection**.
3. Self-registration (D26) is **off** after install. To open sign-up: **Realm settings → Login → User registration: on**
   (email verification is already required), then set `ALLOW_SELF_SERVE_WORKSPACES=true` in `/opt/relay/.env.production`
   and run `sudo infra/oracle/update.sh --restart`. To close it again, switch it off the same way.

Bootstrap points the master realm (the one administrators sign in to) at `http://localhost:3380`, so the console only
works through the tunnel; the public sign-in address answers 404 for `/admin` and `/realms/master`.

The imported realm has no people and no passwords: only the Relay client (with a secret generated on the VM) and its
service account (`view-users` only). Sign-in is passwordless (§7a).

## 7a. Passwordless sign-in (D34) and Google

Relay sign-in is **passwordless**: Continue with Google, or an email with a sign-in button **and** a 6-digit code. Two-step
(authenticator app) is asked for Relay staff at every sign-in and for sensitive actions (billing, removing people, …),
not at ordinary customer sign-in. The sign-in server image (`infra/keycloak/Dockerfile`) carries Keycloak 26.4, the Phase
Two `keycloak-magic-link` extension **0.52** (Elastic License 2.0, from Maven Central, sha256-verified at build), the small
`relay-auth` provider (one email with link + code; Google linking rules) and the Relay theme. `update.sh` builds it.

The realm was imported once at install, so an existing installation is switched **once** with a command. New installs
from this version start passwordless already (the command then just confirms) — so on a new install **nobody can
sign in until the relay realm's email server is set** (§7 step 2).

**Before you switch:** the relay realm needs a working email server (sign-in emails), see §7 step 2 — the command refuses
to switch without one and tells you what to do.

1. Update (builds the new sign-in server image and restarts Keycloak if it changed; about a minute without new sign-ins):

```sh
cd /opt/relay/src
```

```sh
sudo infra/oracle/update.sh
```

2. Switch the live realm (asks for your Keycloak admin sign-in unless the temporary `bootstrap-admin` still exists;
   typed secrets never appear on screen or in files):

```sh
sudo infra/oracle/admin.sh passwordless
```

   It binds the new sign-in flow, sets the Relay login/email theme, turns every password step off (sign-in, reset, account
   console, password grant), adds Google sign-in **switched off**, keeps the two-step flows for staff and step-up, makes
   sign-out return to the Relay home page, and records the previous flow. Safe to run again.

3. Test in a private window: your Relay address → **Log in** → your email → the link or the 6-digit code.

**Undo (lockout safety):** if sign-in emails stop arriving, go back to the previous password sign-in in one command.
Accounts created after the switch have no password; set one for them in the admin console if they need it meanwhile.

```sh
sudo infra/oracle/admin.sh passwordless --undo
```

### Continue with Google (optional, free)

1. In [Google Cloud console](https://console.cloud.google.com/) (any project you own): **APIs & Services → OAuth consent
   screen** — External, app name *Relay*, your support email, scopes `openid`, `email`, `profile`; publish it.
2. **Credentials → Create credentials → OAuth client ID** → *Web application*. Authorised redirect URI (the command below
   prints it too):

```text
https://<your sign-in address>/realms/relay/broker/google/endpoint
```

3. On the VM, paste the client ID and (hidden) client secret when asked. Never put them in chat or the repository.

```sh
sudo infra/oracle/admin.sh google-signin
```

Google links to an existing Relay account **only** when Google reports the same email as verified; a new email creates an
account only when self-registration is on (same rule as email sign-up). Turn Google off again in the admin console:
**Identity providers → google → Enabled: off**.

## 8. First platform operator

1. Create your own Relay account: in the relay realm, **Users → Add user** (email as username, email verified) — no
   password: you sign in with the emailed link or code (§7a); or sign up once self-registration is on. As a platform
   operator you set up an authenticator app at your first sign-in after the grant below.
2. Sign in to `https://relay.vitalos.co.uk` once. The first person to sign in may create the first workspace.
3. Make that account a platform operator (audited; same as `pnpm platform:operator`):

```sh
sudo infra/oracle/status.sh --operator grant you@example.com
```

```sh
sudo infra/oracle/status.sh --operator list
```

## 8a. Vitalos Super Admin status

The Vitalos Super Admin (Product Pipeline → Relay) polls `GET https://relay.vitalos.co.uk/api/platform/v1/status`
with a Bearer token (vitalos-platform ADR-044). It returns aggregates only: workspace and subscription counts and
generic alerts, never names, emails or ids. Bootstrap generates the token into `/opt/relay/.env.production` (added
to an existing file if absent; never printed) and only the web container receives it.

1. Read the token on the VM. Don't paste it into chat, tickets or the repository:

```sh
sudo grep '^RELAY_PLATFORM_STATUS_TOKEN=' /opt/relay/.env.production | cut -d= -f2-
```

2. Put the value in the Super Admin's secret store as its Relay status token setting: the Container Apps secret
   `relay-product-status-token`, referenced by `RELAY_PRODUCT_STATUS_TOKEN=secretref:relay-product-status-token`
   (Super Admin `docs/DEPLOY.md`, products table). Its `RELAY_PRODUCT_STATUS_URL` and `RELAY_PRODUCT_SUPERADMIN_URL`
   defaults already point at this host.
3. Check from the VM. The answer should be `401` without the token and `200` with it (the header is read from stdin, so
   the token doesn't appear in the process list):

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://relay.vitalos.co.uk/api/platform/v1/status
sudo grep '^RELAY_PLATFORM_STATUS_TOKEN=' /opt/relay/.env.production | sed 's/^RELAY_PLATFORM_STATUS_TOKEN=/Authorization: Bearer /' \
  | curl -s -H @- https://relay.vitalos.co.uk/api/platform/v1/status
```

- **No token** in `.env.production`: the endpoint answers 404 and the Super Admin shows "Status not configured".
- **Rotate:** in `/opt/relay/.env.production`, copy the old value to `RELAY_PLATFORM_STATUS_TOKEN_PREVIOUS=`, set a new
  `RELAY_PLATFORM_STATUS_TOKEN=` (`openssl rand -hex 32`), then `sudo infra/oracle/update.sh --restart`. Update the
  Super Admin secret, then remove the `_PREVIOUS` line and restart again.
- **Staging:** set `RELAY_ENVIRONMENT=staging` (otherwise `production` is reported).
- What sets `degraded` or `down`, and how tenants are counted: Help Centre → Developers → Environment variables →
  "Platform status".

## Backups

- Every night at about 03:17 (VM time) `relay-backup.timer` runs `infra/oracle/backup.sh`.
- Each backup is a folder in `/opt/relay/backups/` with: the Relay database, Keycloak's database, database roles, a
  Keycloak realm export, all media, and the settings files (they hold the keys that decrypt stored network
  credentials). Every file is encrypted with the backup key; only its public half is on the VM.
- Kept for 14 days (`RELAY_BACKUP_KEEP_DAYS` in `/opt/relay/.env.infra`), never fewer than the newest three.
- They are on the same disk as the data. To copy each backup off the VM, set `RELAY_BACKUP_RSYNC_TARGET` (an SSH
  destination you own, e.g. a NAS or another server) in `/opt/relay/.env.infra`. Nothing paid is set up.
- Media archiving pauses the storage container for the seconds it takes; uploads in that moment wait, then continue.

Run one now:

```sh
sudo infra/oracle/backup.sh
```

### Restore drill (monthly, safe)

Changes: nothing live. It restores into a temporary database container with no network, forces publishing off in that
copy, shows what would need reconciling, checks the media/realm/settings archives, then deletes the container.

Put the backup key in a root-only file:

```sh
sudo install -m 600 /dev/null /root/relay-backup.key
```

```sh
sudo nano /root/relay-backup.key
```

```sh
sudo infra/oracle/restore.sh --drill /opt/relay/backups/<folder> --identity /root/relay-backup.key
```

```sh
sudo shred -u /root/relay-backup.key
```

### Real restore

Read [backup-restore-and-reconciliation.md](backup-restore-and-reconciliation.md) first. **Never blindly replay
publications**: a restored database does not know about posts sent after the backup.

```sh
sudo infra/oracle/restore.sh --promote /opt/relay/backups/<folder> --identity /root/relay-backup.key
```

What it does: pauses publishing; stops web and worker; keeps the current database as `relay_before_restore_<time>`;
restores; forces publishing **off** before anything connects; re-applies roles and migrations; starts web only. Add
`--keycloak` to also restore sign-in data, `--media` to also restore media (the current copy is kept). Then:

1. Reconcile every delivery due after the backup point (runbook, "Reconcile publications").
2. Turn publishing back on in the admin console (**Platform** → dispatch switch).
3. Start the worker:

```sh
sudo infra/oracle/restore.sh --start-worker
```

**New VM after a disaster:** install Docker, clone the code (step 1), extract the settings from the backup, then run
bootstrap (it keeps existing settings) and the restore:

```sh
sudo infra/oracle/restore.sh --extract-config /path/to/<folder> --identity /root/relay-backup.key --to /root/relay-config
```

Copy `.env.infra`, `.env.production` and `secrets/` from `/root/relay-config` into `/opt/relay/`, then continue with
step 3 and the real restore above.

## Updates

Changes: new images, a database backup first, migrations, then worker and web restart (a few seconds of "502" for
visitors while web restarts).

```sh
cd /opt/relay/src
```

```sh
sudo infra/oracle/update.sh
```

It pulls the code (`git pull --ff-only`), builds the images on the VM (including the sign-in server image; Keycloak restarts only when that image changed), backs up the database, runs the release job, and
restarts worker then web. If the new version is not healthy within four minutes it **switches back to the previous
version automatically**. Migrations stay applied (they are designed to work with the previous version).

Building on the VM uses its CPU (and a few GB of memory) for 5–20 minutes. To build elsewhere instead (any machine with Docker; arm64 needs
QEMU on non-ARM machines):

```sh
infra/oracle/build.sh --platform linux/arm64 --tar relay-images.tar
```

Copy `relay-images.tar` to the VM, then:

```sh
sudo infra/oracle/update.sh --images-tar relay-images.tar --tag <tag printed by build.sh>
```

### Roll back by hand

To go back to the previous version:

```sh
sudo infra/oracle/update.sh --rollback
```

To pick a version that is still on the VM (`docker image ls relay-web` lists them; the last three are kept):

```sh
sudo infra/oracle/update.sh --tag <tag>
```

## Undo the reverse-proxy change

- nginx: `sudo rm /etc/nginx/sites-enabled/relay.conf /etc/nginx/sites-available/relay.conf` (or `conf.d/relay.conf`),
  then `sudo nginx -t && sudo systemctl reload nginx`.
- Caddy: remove the `import /etc/caddy/relay.caddy` line from the Caddyfile (or copy back the saved one from
  `/opt/relay/backups/proxy/<time>/`), delete `/etc/caddy/relay.caddy`, `sudo systemctl reload caddy`.
- Apache: `sudo a2dissite relay && sudo systemctl reload apache2`.
- Traefik: delete the Relay dynamic file, or `/opt/relay/compose.override.yaml` (Docker labels).

## Remove Relay completely

**DESTRUCTIVE**: deletes all Relay data on the VM. Take and copy off a backup first.

```sh
sudo systemctl disable --now relay-backup.timer
```

```sh
sudo docker compose -p relay --env-file /opt/relay/.env.infra -f /opt/relay/src/infra/oracle/compose.prod.yaml --profile caddy --profile jobs down -v
```

Then undo the proxy change (above) and delete `/opt/relay` when you no longer need the backups.

## Troubleshooting

| Symptom | Look at |
|---|---|
| `Refusing to start in production: …` in the web log | The named setting in `/opt/relay/.env.production` (often `SMTP_URL`) |
| `/api/ready` not 200 | `sudo infra/oracle/status.sh --logs web` |
| Sign-in fails with `idp_unavailable` | DNS/HTTPS for `auth.<domain>`; `sudo infra/oracle/status.sh --logs keycloak` |
| Uploads fail | DNS/HTTPS for `media.<domain>`; the browser console for CORS or CSP errors |
| Backup failed | `sudo journalctl -u relay-backup.service` |

More: [health-and-monitoring.md](health-and-monitoring.md), [container-restart-recovery.md](container-restart-recovery.md).
