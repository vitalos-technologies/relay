# Rate limits and usage budgets

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11). AI tokens have their own page:
[ai-budget-exhaustion.md](ai-budget-exhaustion.md).

**Affected resources:** `rate_limit_buckets` (Relay's own limits), `connections.throttled_until`, `provider_circuits`
(network limits), `usage_counters`, `usage_reservations`, `usage_budgets`, `workspaces.limits`, `usage_events`,
`entitlement_overrides`.

## Three different things

| Kind | Example | Error people see |
|---|---|---|
| Relay request rate limits (token buckets in PostgreSQL) | Sign-in 20/min per IP; upload intents 30/min per person; invitations 20/hour per person; API keys 60 burst + 1/s; MCP 120 burst + 2/s; widget per visitor and IP | `429 rate_limited` with `details.retry_after_seconds` |
| Network rate limits | X, Meta, TikTok… return 429 or quota errors | Delivery `retry_wait` (Retry-After respected) or `blocked` with reason `rate_limit`; analytics sync backs off |
| Usage budgets and plan allowances | `x.write`, `x.read`, `exports.count`, `mcp.calls`, `integration.jobs`, `storage.bytes`, `ai.tokens` | `402 budget_exhausted` or `402 entitlement_required`; X deliveries `blocked` with reason `budget` |

## Symptoms

- People report "Too many requests" messages or 429s from the API or MCP.
- X deliveries become Blocked with "budget" while other networks keep publishing.
- Exports, MCP calls or integration syncs refuse with "budget used up" or "not included in your plan".
- Notifications at 50 %, 80 % and 100 % of a budget.

## Diagnostics

1. **READ-ONLY** Workspace caps and usage: `/admin/usage` (owners/admins), or `GET /api/workspace/limits`.
   ```sql
   SELECT meter, period, used FROM usage_counters WHERE workspace_id='<workspace id>' ORDER BY period DESC, meter;
   SELECT limits FROM workspaces WHERE id='<workspace id>';
   ```
   The cap enforced is the lower of the customer's own cap and the plan allowance (plus any audited platform override).
2. **READ-ONLY** Plan allowance and overrides: `/admin/platform/workspaces/<id>` or `GET /api/platform/entitlements/<workspace id>`.
3. **READ-ONLY** Network throttling: `SELECT id, provider, throttled_until FROM connections WHERE throttled_until > now();`
   and open circuits in `/api/ops`.
4. **READ-ONLY** Relay rate limits are per key (IP, person, API key prefix, MCP principal). A burst from one integration
   only affects that key.

## Corrective actions

| Situation | Action |
|---|---|
| Customer cap reached and the customer wants more | The **owner** raises or clears the cap in Usage (`PATCH /api/workspace/limits`, audited). Team caps: `PATCH /api/workspace/limits/teams/<team id>`. Relay staff do not raise customer caps. |
| Plan allowance reached | The workspace upgrades its plan, or a platform operator/billing staff member applies a time-limited, audited **entitlement override** with a reason (`/admin/platform/workspaces/<id>`). |
| X deliveries Blocked for budget | After the cap is raised, retry the blocked deliveries from the post (Blocked deliveries are not Unknown: no duplicate risk). Other networks are unaffected. |
| Network rate limit | Wait. Deliveries retry with the network's Retry-After and within their deadline; analytics backs off. Lower `DISPATCH_PROVIDER_CONCURRENCY_<NETWORK>` if Relay itself is causing the limit. |
| Abusive client hitting Relay limits | Identify the key from logs (API key prefix or MCP client id), revoke the key or the MCP client; for sign-in abuse block at the edge. |
| Stale reservations after a crash | Released automatically by the budget sweep every minute. |

Do not edit `usage_counters` by hand; corrections go through overrides so the usage ledger (`usage_events`) stays
consistent.

## Verification

- `/admin/usage` shows the new cap; the refused action now succeeds.
- Blocked X deliveries move to Scheduled/Published after retry.

## Escalation

A network rate-limits the whole installation (all workspaces) or changes its quota: escalate to the provider adapter
owner; consider lowering per-network concurrency and informing affected workspaces.
