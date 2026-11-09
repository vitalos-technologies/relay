# Key rotation and security incidents

Audience: operators and the incident lead. Repo only. Reviewed 2026-11-09 (product 2026-11).

**Affected resources:** deployment secrets (secret manager / KMS), encrypted columns, sessions, service-account keys,
MCP clients, provider app credentials, the identity provider.

## Secret inventory and how to rotate each

| Secret | Where | Rotate by | Effect |
|---|---|---|---|
| Key-encryption keys (`KEY_ENCRYPTION_KEYS` or KMS-wrapped) | Secret manager / KMS | Add the new key **first** (`<new kid>:<key>,<old kid>:<old key>`), restart web and worker | New secrets use the new key; old blobs still decrypt by their key id. There is no bulk re-encryption job: secrets are re-wrapped only when rewritten (reconnect, setting re-saved). Keep the old key until no blob uses it (query below). |
| `SESSION_SECRET` | Secret manager | Replace, restart web | Signs support-widget form tokens and visitor sessions; open widget forms must be resent. App sessions are random tokens stored hashed and are not affected. |
| OIDC client secret | Identity provider + `OIDC_CLIENT_SECRET` | Create the new secret at the identity provider, update the environment, restart web | Sign-ins in progress fail once; existing sessions continue. |
| Database role passwords | Database + the three role URLs | Change the role password, update the URL, restart the process using it | Restart each process after its URL changes. |
| S3 access keys | Storage provider + `S3_*` | Create a second key, switch, restart, delete the old key | Signed URLs issued before the switch stop working when the old key is deleted. |
| SMTP credentials | Mail provider + `SMTP_URL` | Replace, restart | — |
| Stripe webhook secret | Stripe + `RELAY_STRIPE_WEBHOOK_SECRET` | Put the old value in `RELAY_STRIPE_WEBHOOK_SECRET_PREVIOUS`, the new one in `RELAY_STRIPE_WEBHOOK_SECRET`, restart; remove `_PREVIOUS` after Stripe has switched | No lost events |
| Stripe secret key | Stripe + `RELAY_STRIPE_SECRET_KEY` | Roll the key in Stripe, update, restart | — |
| Slack signing secret | Slack + setup page/env | Same pattern with `SLACK_SIGNING_SECRET_PREVIOUS` | — |
| Provider app secrets (Meta, X, Google, …) | Network developer console + env or setup page | Generate the new secret, save it (write-only), confirm a test connection | Some networks invalidate tokens when the app secret changes; affected accounts must reconnect. |
| Telegram webhook secret | Setup page/env | Only together with the bot's webhook registration; Relay never overwrites an existing Telegram webhook | — |
| Service-account API keys | Workspace settings | Rotate (new key shown once, old key revoked immediately) | Scripts must switch at once |
| MCP OAuth clients | MCP settings page | Revoke and re-approve | Next request fails with 401 |

**READ-ONLY** — which key ids are still in use:

```sql
SELECT 'credentials' t, encrypted_blob->>'kid' kid, count(*) FROM credentials GROUP BY 2
UNION ALL SELECT 'app_settings', value_secret->>'kid', count(*) FROM app_settings WHERE value_secret IS NOT NULL GROUP BY 2
UNION ALL SELECT 'content_connections', credentials_enc->>'kid', count(*) FROM content_connections WHERE credentials_enc IS NOT NULL GROUP BY 2
UNION ALL SELECT 'inbox_channels', secret_enc->>'kid', count(*) FROM inbox_channels WHERE secret_enc IS NOT NULL GROUP BY 2
UNION ALL SELECT 'connection_flows', tokens_enc->>'kid', count(*) FROM connection_flows WHERE tokens_enc IS NOT NULL GROUP BY 2
UNION ALL SELECT 'sessions', id_token_enc->>'kid', count(*) FROM sessions WHERE id_token_enc IS NOT NULL GROUP BY 2;
```

Remove an old key id from the list only when every count for it is zero. Removing it earlier makes those secrets
unreadable (connections fail until reconnected) — effectively **DESTRUCTIVE**.

## Security incident response

### Symptoms

Unexpected publications, audit entries nobody recognises, a leaked key or token, unusual API or MCP traffic, a report
from a network about the app, a lost laptop with production access.

### First hour

1. **Contain.** Pause the affected scope or the installation ([emergency-pause.md](emergency-pause.md)). Revoke the
   suspected credential: API key, MCP client, operator role (`POST /api/platform/operators/<user id>/revoke`), the
   person's sessions (Security → Sessions, or sign them out at the identity provider — back-channel logout revokes
   Relay sessions at once), suspend the account (`/admin/platform/accounts`).
2. **Preserve evidence.** Do not delete rows. Export: `audit_events`, `platform_audit_events`, `mcp_audit`,
   `delivery_attempts` for the window, identity-provider admin events and the relevant JSON log lines (by correlation
   id). Snapshot the database.
3. **Assess.** Which workspaces, brands, accounts and data? What was published or sent? Use the audit trails
   (who, what, when, correlation id). Content is not stored in `mcp_audit`; join ids to posts and deliveries.
4. **Eradicate.** Rotate every secret the attacker could have seen (table above). For provider tokens, disconnect and
   reconnect the affected accounts (revocation happens at the network).
5. **Recover.** Reconcile publications ([failed-and-ambiguous-publications.md](failed-and-ambiguous-publications.md)),
   resume the paused scope, watch closely.

### Afterwards

Inform affected workspace owners with facts (what, when, what you did, what they should do). Legal or regulatory
notification decisions belong to the incident lead and the data protection owner. Write the post-incident review.

## Verification

- Revoked credentials fail (401); new ones work; no unexplained audit entries after containment.

## Escalation

Any suspected exposure of customer data, credentials or the key-encryption keys: incident lead immediately, regardless
of time.
