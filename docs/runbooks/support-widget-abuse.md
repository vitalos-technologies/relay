# Support widget abuse

Audience: platform operators and support staff. Repo only. Reviewed 2026-11-09 (product 2026-11).

**Affected resources:** `widget_visitors`, `widget_sessions`, `widget_verifications`, `widget_submissions`,
`support_tickets` (source `widget`), support attachments in storage, Platform → Support queue, Platform → Marketing
configuration.

## How the widget is protected

- Off by default; platform operators switch it on (`widget_enabled`) and mark it staffed in Platform → Marketing.
- Visitor session cookie; Origin check; a signed form token with a minimum fill time and expiry; a honeypot field.
- Shared PostgreSQL rate limits per visitor and per IP: 5 new conversations per hour per visitor and 10 per IP;
  30 replies per 10 minutes per visitor and 60 per IP; 20 attachments per 10 minutes per IP; reads (polling) 600 per
  10 minutes per IP. Email verification has its own per-IP and per-email limits.
- Size caps on messages and attachments; attachment types restricted and validated.
- A typed email grants nothing; only the one-time email verification links a visitor to existing tickets.
- Diagnostics collected: page path (no query string), browser family, time — nothing else.

## Symptoms

- A burst of new widget tickets, repeated messages, or spam content in Platform → Support (filter source = widget).
- Logs show many `429 rate_limited` from `/api/widget/*`.
- Verification emails sent to addresses that did not ask for them.

## Diagnostics (READ-ONLY)

```sql
SELECT date_trunc('hour', created_at) h, count(*) FROM support_tickets WHERE source='widget' AND created_at > now() - interval '1 day' GROUP BY 1 ORDER BY 1;
SELECT id, name, contact_email, blocked_at, created_at FROM widget_visitors ORDER BY created_at DESC LIMIT 20;
```

Check whether the abuse comes from one visitor (one visitor id across tickets), one IP range (edge logs) or many.

## Corrective actions

| Scale | Action |
|---|---|
| One visitor | **CHANGES DATA** Block the visitor from the ticket: Platform → Support → ticket → Block visitor (`POST /api/platform/support/tickets/<ref>/visitor { "blocked": true }`; support staff; audited). Blocking ends the visitor's sessions; they see "This browser can't use the chat. Email us instead." |
| Spam tickets | Resolve or mark them as duplicates (`…/duplicate { of }`) in Platform → Support. Do not reply to spam. |
| Many visitors or IPs | Block the source at the edge (reverse proxy / WAF). Relay's own limits keep each visitor and IP bounded. |
| Widget overwhelmed or no staff | **CHANGES DATA** Platform → Marketing → turn the widget off, or set it to not staffed (operators, fresh sign-in, reason; audited). The marketing page then hides the widget; existing tickets stay in the queue. |
| Malicious attachments | Attachments are validated on upload; if one slipped through, escalate (see below) and do not open it outside the product. |
| Verification email abuse | Verification sending is rate-limited per IP and per email; turn the widget off if it persists. |

## Verification

- New widget tickets return to normal rates; blocked visitors cannot create tickets; Platform → Marketing shows the
  intended state.

## Escalation

Targeted harassment, threats, illegal content or anything suggesting an attack on the support staff or the platform:
incident lead. Preserve the tickets (do not delete them).
