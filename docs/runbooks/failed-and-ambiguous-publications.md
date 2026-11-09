# Failed and ambiguous publications

Audience: operators and workspace admins. Repo only. Reviewed 2026-11-09 (product 2026-11). Background:
`content/help/developers/publishing-engine-and-delivery-states.md`.

**Affected resources:** `deliveries`, `delivery_attempts`, schedules and posts; the networks' accounts.

> **Rule:** never resend a delivery that may already be live without checking the channel first. Unknown means
> "the network may have created the post".

## Symptoms

- A post shows **Needs attention**, **Partial**, **Failed** or **Expired**; a destination shows **Unknown — needs
  review** or **Manual handoff**.
- `/admin/publishing` lists Unknown, Failed, Blocked or Expired deliveries.

## Diagnostics

1. **READ-ONLY** Delivery evidence: `/admin/publishing` → the delivery (or `GET /api/admin/deliveries/<id>`) shows every
   attempt, the network's response classification, provider ids and which recovery actions apply.
2. **READ-ONLY**
   ```sql
   SELECT d.id, d.provider, d.state, d.phase, d.attempt_count, d.max_attempts, d.last_error_code, d.last_error_message,
          d.unknown_since, d.needs_reconcile, d.provider_ids, d.publish_before
     FROM deliveries d WHERE d.post_id='<post id>' ORDER BY d.created_at;
   SELECT attempt_number, kind, phase, started_at, ended_at, outcome, safe_code, safe_message, provider_ids,
          duplicate_risk_acknowledged, correlation_id
     FROM delivery_attempts WHERE delivery_id='<delivery id>' ORDER BY attempt_number;
   ```
3. Interpret the state:

| State | Meaning | Automatic handling |
|---|---|---|
| `failed` | Network rejected the post permanently, or retries/deadline ran out after safe rejections | None; safe to retry manually after fixing the cause |
| `expired` | Publish-before deadline passed before it could be sent (pause, outage, blocked account) | None |
| `unknown` | Sent (or possibly sent) but no reliable answer | Read-only reconciliation every 15 s with backoff, up to 10 checks |
| `handoff` | The network holds a draft that a person must finish in its app | Relay watches for it being posted where the network allows |
| `blocked` | Needs an account, permission, budget, authority or plan fix | Released by the fix ([expired-provider-auth.md](expired-provider-auth.md), [rate-limits-and-budgets.md](rate-limits-and-budgets.md)) |

## Corrective actions

### Unknown

1. Let automatic reconciliation finish (up to 10 checks). It marks the delivery Published if it finds the post, or
   Failed if the network confirms it does not exist.
2. Networks that cannot be searched (for example Telegram) stay Unknown. Open the channel and look for the post around
   the attempt time.
3. **CHANGES DATA** Resolve it on the post (or `POST /api/deliveries/<id>/resolve`):
   - found → **Published**, paste the post link (`https://…`);
   - not there → **Not published**.
4. Only if you cannot check and the post must go out: **Retry** with "I accept the risk of a duplicate"
   (`acknowledge_duplicate_risk: true`). It is audited and gets one attempt. This may create a duplicate post.

### Failed

1. Read `last_error_message` (the network's reason, translated). Typical causes: content violates a network rule,
   media rejected, account restricted.
2. Fix the content or account, then **Retry** (`POST /api/deliveries/<id>/retry`) — or edit and reschedule the post,
   which creates a new schedule generation.

### Expired

Nothing will be sent. If the post is still relevant, reschedule it. Do not bulk-reschedule expired posts after an
outage without checking with the workspace: the content may be out of date.

### Partial

Some destinations published and others failed. Handle each destination separately; never reschedule the whole post,
which would republish to destinations that already succeeded.

### Manual handoff

The person completes the post in the network's app, then resolves it as Published with the link (or Not published).

## Verification

- The destination shows Published with a working link, or Failed/Not published with a reason the workspace accepted.
- No Unknown deliveries older than one hour without an owner.

## Escalation

Many Unknown deliveries for one network at once (network timeouts or an outage), or reconciliation returning
`still_unknown` repeatedly for a network that supports search: pause that network's brands, collect delivery ids and
correlation ids, and escalate to the provider adapter owner. If duplicates were created, tell the workspace which
posts and links — never delete posts on a customer's account on their behalf.
