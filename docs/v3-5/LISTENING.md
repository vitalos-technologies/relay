# Listening — coverage, metric definitions and behaviour (stream D)

Brief §14–15. Migration `031_v35_listening.sql` (applied to dev 2026-11-08, frozen). Code: `packages/services/src/listening/*`,
contract `packages/core/src/contracts/v35-listening.ts`, API `/api/listening/**`, UI `/listening`, Settings → Listening → Sources.

## Two layers

| Layer | What | Status in this build |
|---|---|---|
| Connected-source monitoring | Public **comments, mentions and reviews** from inbox channels (any network whose inbox capability has a public type — Facebook Page today; networks stream B adds flow in automatically). **Private messages are never observed** (DB check: `conversation_kind <> 'dm'`). | Implemented; exercised on the simulated Facebook Page. Live data needs Meta App Review (see the inbox activation items). |
| Broader listening | X search (paid credits), YouTube search (API key + quota), Bluesky search (app password), Reddit (commercial terms), licensed news/web/forums | Provider interface + coverage registry only. No adapter is implemented or activated, so every broad source shows **Awaiting activation** and contributes no data. |
| Never offered | Logged-in scraping, bypassing access controls, private groups/messages, "complete coverage" claims | Refused by policy. |

Provider interface (`sources.ts`): `ListeningProvider { key, activated(workspaceId), search(workspaceId, { terms, since, until, cursor, limit }) }`
registered with `registerListeningProvider`. Broad observations use the same `listening_observations` rows (`layer='broad'`,
unique per `(workspace, source_key, external_id)`); a provider is only "active" when `activated()` is true (credentials /
licence / approval), never because a mock exists.

## Data flow

```
inbox ingest (verified webhook / polling / simulated) ─▶ inbox_messages ─outbox 'inbox.message_received'─▶ 'inbox-events'
   └ hook listening.observe (public kinds only) ─outbox 'listening.ingest_requested'─▶ 'listening-ingest' (bulk pool, listening_ingest)
        └ observeMessage: classify (language, lexicon sentiment, terms, fingerprint) → listening_observations → match saved
          searches → listening_matches → evaluate alert rules (throttled) → listening_alerts (+ evidence, coverage snapshot)
catch-up: worker sweep over inbox_messages (cursor, items ≥ 1 min old) every 30 s — covers missed events and new networks
edits/deletes at source: trigger on inbox_messages (031) updates/erases the observation in the SAME transaction
```

Workload isolation: listening runs on the bulk pool (`listening_ingest`: 1 per process / per workspace, defers under
publishing pressure) — it cannot delay customer replies or publishing.

## Saved searches

- **Names and aliases** (any matches) ∪ **keywords** (any matches), then the optional **advanced query** must also match, then
  any **exclusion** removes the item. Language filter (ISO codes; "undetermined" never matches a language filter), source
  filter (source keys; empty = all monitored), kind filter (comment/mention/review).
- Boolean grammar (same parser in browser and server): `AND`, `OR`, `NOT` / `-term` (upper-case operators; implicit AND),
  `"exact phrase"`, `(brackets)`, `prefix*` (≥ 3 letters), `#hashtag`, `@handle`. Whole words, case- and accent-insensitive;
  a plain word also matches its `#tag`/`@handle` form. Limits: 500 characters, 50 terms, 10 nesting levels. Errors carry the
  character position.
- **Query version**: editing the definition creates version n+1 (`listening_search_versions`) and re-matches stored
  mentions in the background; every result states the version it used. Optimistic concurrency (`expected_version`).
- **Test** previews a definition against the last 30 days of stored mentions without saving.

## Metric definitions (also `LISTENING_DEFINITIONS` in the contract, shown as info tips)

| Metric | Definition |
|---|---|
| Mention | A public comment, mention or review from a monitored source that matches the search. |
| Unique mentions | Repeats collapsed: identical text after removing links, @handles, punctuation, case and accents, same brand, within 7 days, counts once (texts under 12 normalised characters are never collapsed). A repeat counts again only if its original is outside the result. |
| Sentiment | **Inferred, not fact.** Lexicon baseline (`lexicon_v1`): weighted English words + emoji, negation flips within a clause, intensifiers; score Σw/√(Σw²+4); confidence from number of hits and agreement; < 50 % ⇒ *uncertain* (shown with "?"). Non-English ⇒ *Not scored*. The words that produced the score are stored and shown. Managers can correct a label; corrections win everywhere and are audited; an edit at source clears the correction. No sensitive traits or demographics are inferred. |
| Sentiment shares | Denominator = scored unique mentions (unscored excluded and reported separately). |
| Topics | Salient keywords and adjacent pairs that co-occur in ≥ 2 (≥ 3 when n ≥ 20) unique mentions; search terms excluded; a pair replaces its words when it explains ≥ 60 % of them. Groups overlap. |
| Share of voice | Each search's unique mentions ÷ the sum across the compared searches; same brand, same window, **comparable sources only** (the intersection of the searches' source filters); within observed data only. A mention naming two compared brands counts for each (the denominator is the sum). |
| Timeline buckets | Hour (≤ 2 days) or day, UTC. A bucket that ended before monitoring began is **not collected** (null, drawn as a gap) — never zero. Previous-period comparison only when the previous period was fully monitored. |
| Spike | Window count (epoch-aligned, 15 min–24 h) fires when ≥ minimum sample AND ≥ ⌈mean × multiplier⌉ AND ≥ ⌈mean + 3σ⌉ AND > mean, over the same-length windows of the previous *baseline days* **that were monitored**; needs ≥ *minimum baseline windows*. One alert per rule + dataset + window (unique key), then a cooldown. Metric: all mentions or negative mentions. |

## Coverage statement (on every chart, list and alert)

`ListeningCoverage`: dataset (live / simulated — never mixed), window, sources with channel counts and status, broad sources
awaiting activation, `history_from` (monitoring start: the channel's inbox opt-in or earlier history the provider returned),
`partial_window`, incomplete channels with reasons (permission missing, error, paused, disconnected, excluded), `retrieved_at`,
query version, sample (`observations`, `unique`, `duplicates_collapsed`, `removed_at_source`), state and method notes.

States: **matches** · **no_matches** (sources were collecting, nothing matched) · **incomplete** (no matches and at least one
channel was not collecting) · **not_collected** (no channel in scope at all). The UI words each differently.

## Alerts (acceptance test 10)

Fired alerts store the exact observations counted (`listening_alert_evidence`, up to 500), the coverage snapshot and the query
version. The alert page lists those mentions (removed-at-source ones shown as removed, with the count), the baseline,
threshold and minimum sample. Recipients (default: the creator) get an in-app/email notification under the *Account health*
preference; entitlement (`listening.read` on the brand) is re-checked at delivery, so revoked members receive nothing.
`listening.alert_fired` is emitted on the `inbox-events` queue for `onInboxEvent` subscribers (Slack — stream C; automation —
stream E). Acknowledge / dismiss / reopen are audited.

## Insight → work

From a mention, alert or search: **task** (collab tasks; `content.read` + contributor on the brand), **case** (mention only —
its conversation; `cases.manage` + inbox access; an existing case is linked, not duplicated), **content draft** (posts;
`drafts.edit`). Idempotent per click (`listening_insight_actions` unique key + advisory lock). No customer text is copied into
the new record — only a link back — so deletions at source propagate.

## Deletion, correction and retention

| Event | Effect |
|---|---|
| Provider deletes the item / inbox retention erases the body | Trigger (same transaction): observation body, terms, evidence words and fingerprint erased, `removed_at` set, matches deleted (out of the search index and every count); repeats re-point to the earliest remaining copy. Alerts keep their fire-time count and show "removed at source since". |
| Provider edits the item | Body updated, `needs_reprocess` → re-classified, re-fingerprinted, re-matched by the worker; a manual correction for the old text is cleared. |
| Hard delete (workspace/channel removal) | `ON DELETE CASCADE`. |
| Channel excluded from listening | Its observations are deleted from listening (the inbox keeps the messages); re-including backfills from stored inbox items. |
| Manager excludes a mention | Kept out of every metric (audited, reversible). |
| Ingest failure log | 30 days. |
| Observations, matches, alerts | Workspace lifetime, following the inbox's retention (policy-based purge: stream F). |

## Permissions

| Permission | owner | admin | brand_manager | editor | analyst | care_agent |
|---|---|---|---|---|---|---|
| `listening.read` (dashboards, searches, mentions, alerts, own dashboards, tasks from insights) | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `listening.manage` (searches, alert rules, corrections, exclusions, source settings) | ✓ | ✓ | – | – | – | – |

Private conversations stay under `inbox.read`; listening never shows DMs. Opening a conversation or creating a case from a
mention needs the inbox/cases permissions too. Platform operators get nothing implicitly. Membership revocation takes effect
on the next request (access is reloaded per request) and on alert delivery.

## AI

Relay's AI service currently exposes post-copy suggestions only (`services/ai`), so listening uses the transparent lexicon
baseline. A budget-gated AI classifier can plug in later (results would carry their method and stay correctable); the
assistant's "summarise listening results with evidence" is stream E's.
