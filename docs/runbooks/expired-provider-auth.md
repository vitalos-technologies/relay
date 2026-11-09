# Expired or revoked provider authorization

Audience: operators and workspace admins. Repo only. Reviewed 2026-11-09 (product 2026-11).

**Affected resources:** `connections` (status, `health_detail`), `credentials`, deliveries of those connections,
Content Hub and business-app connections (`content_connections`, `integration_connections`).

## Symptoms

- An account shows **Reconnect required**, **Missing permission** or **Expiring** on the Accounts page or
  `/admin/connections`.
- Deliveries for that account become **Blocked** with a reason; owners and admins receive one notification
  (deduplicated).
- Imports from Drive/Docs/Notion, analytics sync or business-app sync stop with "access ended" or a reconnect message.

## Diagnostics

1. **READ-ONLY** Connection health (checked every 10 minutes, 25 connections per run, and on every failed call):
   ```sql
   SELECT id, workspace_id, provider, display_name, status, health_detail, health_checked_at, throttled_until
     FROM connections WHERE status NOT IN ('ready','disconnected') AND NOT is_mock ORDER BY health_checked_at;
   ```
   Statuses: `expiring` (token expires within 7 days), `missing_permission` (scopes or page tasks removed),
   `reconnect_required` (token revoked/expired or refresh failed), `paused`.
2. **READ-ONLY** Blocked deliveries and why:
   ```sql
   SELECT connection_id, last_error_code, blocked_reason, count(*) FROM deliveries
    WHERE state='blocked' GROUP BY 1,2,3 ORDER BY 4 DESC;
   ```
   `last_error_code` `authority_hold`, `brand_rule_review` and `entitlement_hold` are **not** credential problems: a
   reconnect does not release them (see "Other holds" below).
3. **READ-ONLY** `/accounts/health` and `/admin/connections/diagnostics` show per-connection detail and the exact fix the
   network reported. Missing network-level approvals (for example Meta insights or inbox permissions) show as missing
   permission until the app is approved and the matching setting (`META_REQUEST_INSIGHTS`, `META_REQUEST_INBOX`) is
   turned on.

## Corrective actions

1. Ask a person with `connections.manage` on the brand to **Reconnect** the account (Accounts → the account →
   Reconnect). It needs a fresh second-factor sign-in (step-up). Relay never reconnects on someone's behalf.
2. Reconnecting the **same** network identity returns Ready. Blocked deliveries that are still within their deadline
   go back to Scheduled automatically; those past their deadline become Expired with "the deadline passed while the
   account needed attention" (they are not flooded out late).
3. Reconnecting with a **different** identity creates a new connection; old deliveries are not redirected to it.
   Reschedule those posts deliberately.
4. Content sources and business apps: reconnect from their integration page; pending imports, writeback and exports
   that stopped must be requested again.
5. If the network app itself lost approval or credentials (all connections of one network fail at once), fix the app
   settings (environment or setup page) — see `content/help/developers/environment-variables.md` — then reconnect.

### Other holds

| `last_error_code` | Released by |
|---|---|
| `authority_hold` | An authorized publisher adopting the publication (`/admin/people/held`) |
| `brand_rule_review` | A brand-rule review decision |
| `entitlement_hold` | The workspace's plan or billing state allowing the work again (sweep every 5 minutes) |

## Verification

- The connection shows Ready and `health_checked_at` is recent.
- `SELECT state, count(*) FROM deliveries WHERE connection_id='<connection id>' GROUP BY state;` shows no `blocked`
  rows except expected holds.
- The next due post on that account publishes.

## Escalation

Every connection of one network fails at the same time (app suspended, network outage, changed API): pause that
network's brands if posts are at risk ([emergency-pause.md](emergency-pause.md)), check the network's status page and
developer notices, and escalate to the engineering owner of that provider adapter.
