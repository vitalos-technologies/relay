# Collaboration — implementation gaps and limits

Honest list of what is not built, partly built, or limited. Nothing here is presented in the product as available.

## Not built

| Item | Why / what exists instead |
|---|---|
| **Team mentions** (`@team`) | The brief requires a separate permission and rate limits first. Only individual mentions exist (bounded search, entitlement at send, 100 mentions/hour per person). |
| **Live character-level co-editing** | Out of scope (did not exist before). Saves are revision-checked; conflicts are resolved field by field (`CONCURRENT_EDITING.md`). The UI never calls it live co-editing. |
| **MCP access to discussions, tasks or notifications** | No MCP tools expose collaboration data, so nothing there can instruct an AI client or mass-mention. Adding them needs the same services, scopes, audit and approval rules (`docs/V3_MCP_GUIDE.md`). |
| **Push / mobile OS notifications** | In-app (bell, centre) and email only. |
| **Comment attachments / media anchors in the UI** | The API and data model support media anchors (`{kind:'media', asset_id}`, flagged outdated when the media is removed); the editor only offers “Comment on selection” for text. |
| **Search and export of discussions / tasks** | Deliberately not indexed or exported (internal notes must never leak through search or exports). Tasks are not searchable yet. |
| **Offline comment queue** | Drafts work offline (V3.1); posting a comment needs a connection — the box keeps your text and shows the error. |

## Partly built / limits

| Item | Limit |
|---|---|
| “Comment on selection” | Shown in the base text view. Selections in a per-network custom text are captured by the API/anchor model but the button is only in the base header. |
| Realtime | Server-Sent Events backed by a 1.5 s database poll per open stream (no LISTEN/NOTIFY fan-out); each stream re-checks access every 15 s and ends after 55 s. Cost scales with open post pages; measured on the dev host only (`TEST_REPORT.md`). Polling fallback is every 10 s. Guests on the review portal refresh every 30 s (no stream). |
| Notification latency under bursts | One worker processes collaboration notifications two at a time (workload class `notifications`). A synthetic burst of ~800 reply events drained in about 2–3 minutes (p95 queue wait 68 s). Normal single events arrive within seconds. Raise `WORKLOAD_NOTIFICATIONS_CONCURRENCY` or add workers for larger teams. |
| Presence | Composer only (not the review page or portal). Heartbeat every 20 s, so “editing” can lag up to 20 s (an edit flip is sent immediately). |
| Revision ↔ draft version mapping | Submitted revisions are matched to the draft version saved just before them (by time); approvals themselves bind to the exact revision. |
| Activity tab | Built from the audit log rows that reference the post, its reviews/schedules or carry `post_id`; older audit rows without a post reference don't appear. |
| Daily digest email | Lists generic titles only (no post context), by design. |
| Mention candidate search | Prefix match on name/email over active members (≤ 40 scanned, ≤ 8 shown). People who match only by a middle part of an email aren't suggested. |
| Offboarding | The sweep handles tasks (flag or unassign). Review assignees and post owners who lost access are listed for reassignment but not changed automatically. |
| Accessibility | Keyboard paths and labels were checked by the E2E/mobile scripts; no full screen-reader pass was done. |

## Test-suite note

`tests/e2e/security.spec.ts` "back-channel logout" fails when the approver identity has other live Keycloak sessions from
earlier specs (Keycloak then sends the logout token for a different session). `collaboration.spec.ts` therefore uses Eden
(editor) and Vic (viewer), never the approver. Pre-existing sensitivity of that test, not a product change.

## Needs a decision

- Whether notification bodies should ever include the post title in **email** (currently never — safer for lock screens and
  shared inboxes).
- Default for “Clients can comment on shared reviews” (currently on, as in V2).
- Retention of `collab_events` (7 days) and presence (10 minutes) — operational only, no history kept.
