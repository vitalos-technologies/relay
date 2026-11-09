# Emergency pause

Audience: operators and workspace owners/admins. Repo only. Reviewed 2026-11-09 (product 2026-11).

Use when something must stop going out **now**: wrong content scheduled, a compromised account, a network incident,
a release bug, or a restore in progress.

**Affected resources:** deliveries not yet sending in the chosen scope; provider-held releases (YouTube scheduled
publication); `workspaces.publishing_paused`, brand and connection pause flags, `system_flags.dispatch_enabled`.

## Choose the smallest scope that stops the problem

| Scope | Who | How | Audit |
|---|---|---|---|
| One account (connection) | Brand managers/admins | Accounts → the account → Pause | yes |
| One brand | People with `publishing.pause` on the brand | Brand settings → Pause publishing; MCP `pause_brand` | yes |
| One workspace | Owner, admin or approver | Sidebar **Pause** (`POST /api/workspace/pause { "paused": true, "reason": "…" }`) | yes |
| One workspace (Relay staff) | Platform operator, fresh sign-in | `/admin/platform/workspaces/<id>` → Suspend (members lose access to the workspace until it is reactivated; waiting deliveries move to Paused) | platform + workspace |
| Whole installation | Platform operator, fresh sign-in | `/admin/platform` → dispatch switch off (`POST /api/platform/dispatch { "enabled": false, "reason": "…" }`) | platform |

Last resort if the admin console is unavailable: **CHANGES DATA**
`UPDATE system_flags SET value='false'::jsonb, updated_by='<operator>', updated_at=now() WHERE key='dispatch_enabled';`
Workers stop claiming within about a second. Stopping the worker processes also stops dispatch, but in-flight leases
then expire into Unknown; prefer the switch.

## What a pause does and does not do

- Checked at dispatch, before preparing and again inside the send transaction: nothing new is sent after the pause
  commits.
- A request **already sending may complete** — it cannot be recalled. Check those deliveries afterwards.
- Not-started deliveries in a paused workspace, brand or account move to **Paused**.
- Provider-held releases: Relay tries to cancel them at the network and shows the residual risk if cancellation cannot
  be confirmed. Check those posts on the network.
- Already published posts are **not** removed. Deleting a published post is done on the network by the account owner.
- The installation dispatch switch and the pauses above stop **publishing** only; inbox replies, imports and other
  jobs continue. To stop automatic customer replies, stop the workspace's automation policies (per policy or the
  workspace-wide emergency stop, `automation.manage`; queued automated replies are cancelled). Feature-flag kill switches
  in `/admin/platform/rollouts` exist only for the flagged features (onboarding checklist, content queue, tracked
  links, brand rules, integration diagnostics, release notes). To stop AI features everywhere, remove the AI provider
  key ([ai-budget-exhaustion.md](ai-budget-exhaustion.md)).

## Verification

- **READ-ONLY** `SELECT state, count(*) FROM deliveries WHERE workspace_id='<workspace id>' AND state IN ('scheduled','retry_wait','preparing','publishing','paused') GROUP BY state;`
  No `preparing` or `publishing` rows remain after a minute; due work shows `paused` (or stays scheduled but unclaimed
  when the installation switch is off).
- Worker logs show no new `delivery_processed` lines for the scope.

## Resume

1. Fix the cause first.
2. Un-pause the same scope you paused (resume needs `publishing.resume` for brand/workspace scopes).
3. Deliveries still within their deadline return to **Scheduled** and go out in due order; those past their
   publish-before deadline become **Expired** — they are never flooded out late. Reschedule expired posts only after
   checking they are still relevant.
4. After an installation-wide pause, watch `/admin/operations` until the backlog drains.

## Escalation

If you are unsure what was sent during the incident, follow [failed-and-ambiguous-publications.md](failed-and-ambiguous-publications.md)
for each Unknown delivery and inform the affected workspaces with the list of posts and links.
