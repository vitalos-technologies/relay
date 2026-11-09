# AI budget exhaustion and AI provider problems

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11).

**Affected resources:** the `ai.tokens` usage meter (`usage_counters`, `usage_reservations`, `usage_events`),
`workspaces.limits.ai_monthly_tokens`, team budgets (`usage_budgets`), plan allowances and overrides, `ai_usage`,
`ai_runs` / `ai_run_steps`, the AI provider credentials.

## Symptoms

- The assistant, AI workflows, inbox suggestions or support AI drafts refuse with "The monthly AI budget is used up"
  (`402 budget_exhausted`), or a workflow run stops at a step with `budget_exhausted`.
- "AI isn't set up" / `provider_not_configured`.
- "Too many requests" from the assistant (20 runs per 10 minutes per person).
- Runs fail with provider errors; Platform → AI shows failed steps.

## Diagnostics (READ-ONLY)

1. Workspace usage and caps: `/admin/usage` or `GET /api/workspace/limits` (owner/admin).
   ```sql
   SELECT meter, period, used FROM usage_counters WHERE workspace_id='<workspace id>' AND meter='ai.tokens' ORDER BY period DESC LIMIT 3;
   SELECT limits->'ai_monthly_tokens' FROM workspaces WHERE id='<workspace id>';
   ```
   Default cap without a configured value: 200,000 tokens per month. The enforced cap is the lower of the customer cap
   and the plan allowance; a team budget can be lower still for members of that team.
2. Each AI call **reserves** an estimate before it runs (the assistant reserves up to 8,000 output tokens plus prompt
   size). A workspace with a few thousand tokens left can therefore already be refused.
3. Plan allowance and overrides: `/admin/platform/workspaces/<id>` (entitlements).
4. Provider configuration: Platform → AI (`/admin/platform/ai`) and the setup page AI group. `ANTHROPIC_API_KEY` must be
   set (environment or setup page) **and** `AI_MODEL` (environment; no default — D32). `AI_MODEL_PRICES` is optional
   (cost estimates show as unknown without it; budgets work on tokens either way). `AI_FIXTURE` must be false in production.
5. Run history (no prompt or output text is shown to admins):
   ```sql
   SELECT task, status, status_detail, input_tokens, output_tokens, created_at FROM ai_runs WHERE workspace_id='<workspace id>' ORDER BY created_at DESC LIMIT 20;
   ```
6. Cloud Translation has its own monthly **character** cap per workspace ("monthly translation limit reached"); it does
   not use AI tokens.

## Corrective actions

| Cause | Action |
|---|---|
| Customer cap reached | The owner raises or clears `ai_monthly_tokens` in Usage (`PATCH /api/workspace/limits`, audited), or a team cap (`PATCH /api/workspace/limits/teams/<team id>`). |
| Plan allowance reached | The workspace upgrades, or billing staff apply a time-limited, audited entitlement override with a reason. |
| Stale reservations after a crash | Released by the budget sweep every minute; wait a minute and retry. |
| Provider not configured | Configure the key (environment or setup page) and `AI_MODEL` (environment, restart needed); restart is not needed for setup-page values. Setup → AI assistance shows which is missing. |
| Provider errors or outage | AI features fail without affecting publishing. Wait. There is no dedicated installation-wide AI switch: to turn AI off everywhere, remove the AI provider key (setup page, or unset `ANTHROPIC_API_KEY` and restart), which makes every AI feature refuse with `provider_not_configured`. Automation policies that depend on AI stop safely. |
| Runaway usage by an automation | Stop the automation policy (per policy or the workspace-wide emergency stop). |

Never reset `usage_counters` by hand; corrections go through caps or overrides so the usage ledger stays consistent.

## Verification

- `/admin/usage` shows headroom; a new assistant run completes; Platform → AI shows successful runs.

## Escalation

Unexpected token consumption (a workspace burning its budget in minutes), or provider billing alerts: stop the
responsible automation, remove the AI provider key if needed, escalate to the AI owner and the billing owner.
