# V3.5 implementation gaps (final)

What V3.5 does **not** do yet, and why. Stream F, 2026-11-08. Activation items (credentials, approvals, licences) are in
`FINAL_ACTIVATION_CHECKLIST.md`; this file lists product/engineering gaps.

## Externally blocked (cannot be closed in code alone)

| Gap | Blocked on | Category |
|---|---|---|
| No capability verified against a live provider | Credentials, app reviews, designated test accounts (checklist §1–2) | Awaiting credentials or review |
| X, LinkedIn and TikTok inboxes: no adapter | Provider access (X paid API, LinkedIn Community Management API, TikTok API for Business) | Awaiting review / paid access |
| Broader listening (X search, YouTube search, Bluesky search, Reddit, news/web): no provider adapter | Licences / commercial terms / budget | Awaiting licensed data access |
| Real AI output (assistant, AI automatic replies) | AI provider key (Setup) | Awaiting credentials |
| Pinterest comments/DMs, Threads DMs, TikTok DMs | No official API | Unsupported by the provider |
| Logged-in scraping, "all of social" listening | Refused by policy | Unsupported (by design) |

## Not implemented (product/engineering)

| Gap | Notes | Suggested next step |
|---|---|---|
| Configurable per-workspace retention for customer message text | Message bodies are kept for the workspace lifetime unless deleted at the provider (`SECURITY_AND_RETENTION.md`). | Migration adding `inbox_retention_days` + a worker sweep that nulls bodies (the 031 trigger already propagates to listening). Needs a default from the user/legal. |
| Instagram mentions, Threads mentions | Need extra lookups / approvals | Stream B follow-up after App Review |
| Facebook Page mentions | Not built (capability matrix) | After Meta approval |
| AI sentiment/topic classification for listening | Lexicon baseline only (transparent, English) | Needs an AI classification task + budget |
| Mailchimp campaign drafts from automation | Deliberately not offered: drafts are made from approved posts with explicit list/subject choices | Revisit only with a product decision |
| Per-workspace drill-down for platform operators | Platform view is installation-wide counts only | Decide whether operators need per-workspace counts (still content-free) |
| Inbox in the phone bottom bar; main-nav grouping | Open user decisions (copy/IA pass) | See `docs/v3-5-progress/final.md` → Nav proposal |
| MCP: send replies | Not offered by design (drafts only); a send tool would need the MCP intent/confirmation pattern used for publishing | Only if the user asks for it |
| GBP review notifications for **simulated** installations | Pub/Sub handler matches selected location resources; simulated installs expose simulated locations without resource rows, so they are only polled | None needed (simulation only) |
| Existing API-key MCP clients | Keep their pre-V3.5 scopes; must be re-created to get the new scopes | Documented (checklist §5) |

## Known limitations kept on purpose

- Pages never wait on providers or AI: health and states shown are as of the last stored sync/poll.
- Translation cost is an estimate (list price × characters incl. markup); the free tier is not subtracted.
- Listening metrics before monitoring started are gaps, not zeros; simulated and live data are never combined.
- Automatic replies never rely on model confidence; uncertain, sensitive, refund and complaint messages always go to a person.
