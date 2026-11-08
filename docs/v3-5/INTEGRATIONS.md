# V3.5 business integrations (stream C)

Asana, monday.com, HubSpot, Google Business Profile, Google Cloud Translation, Slack and Mailchimp. Built on the foundation
connector infrastructure (`docs/v3-5/DATA_MODEL_AND_EVENTS.md`); migration `030_v35_integrations.sql`. Official docs were
re-checked on **2026-11-08** (sources at the end). No provider credentials exist in this environment: every connector has a
complete OAuth / operator-credential flow that reads Setup values, shows **Needs app setup** while they are missing, and is
exercised end to end on **simulated provider APIs** (`mock_` installations, labelled *Simulated*) plus locally signed webhook
fixtures. Nothing has been verified against a live provider.

## Where things are
| What | Where |
|---|---|
| Hub (all seven, state, connect, installations) | `/integrations`, `/integrations/<connector>` (left nav on ≥1024 px; Settings → Connections → Business integrations links here) |
| Per installation | status + health + diagnose · pause/resume · reconnect · disconnect (provider revoke where offered) · Resources (explicit selection) · Sync rules (contract + mappings) · Settings (connector-specific) · History (sync jobs with retry, activity incl. rate limits) |
| Tasks / HubSpot ticket for a case or conversation | Inbox → conversation → customer panel → *External work* |
| Translation in the inbox | Inbox → customer panel → *Translate* (latest message; reply draft → exact outgoing text, copy only) |
| Google posts, Mailchimp draft, tasks for a post | Composer → *Integrations* card |
| Slack identity link | `/integrations/link/slack?t=…` (opened from a Slack button) |
| Operator settings | Setup → Asana / monday.com / HubSpot / Google Business Profile / Google Cloud Translation / Slack / Mailchimp |

## Connect, scope, credentials
- OAuth (`/api/connectors/oauth/<connector>/start` → provider → `/callback`): state = sha256, single use, 10 minutes, bound to
  the initiating user + workspace + brand; PKCE where supported (Asana, Google). Authority (`integrations.manage` on the brand,
  or workspace scope) is re-checked at the callback; a reconnect must authorise the **same** external account. Provider error
  text is never echoed.
- Cloud Translation connects with the **operator's** service account (Setup); a workspace admin installs it (workspace scope).
- Credentials live in the envelope-encrypted `credentials` vault; refresh is serialised per installation (advisory lock),
  outside transactions. A refused refresh or a 401 marks the installation *Reconnect*, deletes the credential, and marks all
  its links **unavailable** — Relay records are kept.
- Simulated installs: `POST /api/connectors/hub/simulated` (refused in production / without mock providers). A scenario switch
  (outage, rate limited once, lost response, revoked, missing permission) exercises recovery.

| Connector | Auth | Scopes (least privilege) | Inbound |
|---|---|---|---|
| Asana | OAuth + PKCE | tasks:read, tasks:write, projects:read, users:read, workspaces:read, webhooks:write (no tasks:delete) | webhook per project (`?i=<installation>`, X-Hook-Secret handshake, HMAC) + polling every 15 min (webhooks are at-most-once) |
| monday.com | OAuth | boards:read, boards:write, users:read, webhooks:write | board webhook (`?i=`), JWT signed with the app signing secret + polling |
| HubSpot | OAuth | crm.objects.contacts.read, crm.objects.companies.read, tickets, crm.objects.owners.read | app webhooks (v3 signature with the client secret), `portalId` → installation |
| Google Business Profile | OAuth + PKCE | business.manage (+ openid email for the identity) | Pub/Sub push: Google-signed OIDC token (RS256 via Google certs; audience + service account + expiry checked) |
| Cloud Translation | Service account (JWT bearer) | cloud-translation | none |
| Slack | OAuth v2 | chat:write, channels:read, groups:read (no users:read.email) | interactivity (`X-Slack-Signature`, 5-min window, rotation) |
| Mailchimp | OAuth | account-wide (Mailchimp has no granular scopes — shown in the hub) | per-installation URL key (baseline) or `X-Mailchimp-Signature: t=<ts>,v1=<hex HMAC(secret, ts + "." + body)>` |

## Synchronization contract
Default: every field flows **Relay → external** only. Two-way only for fields someone maps two-way (tasks: title, due date,
status). Protected fields (approval/publish state, owner/assignee, consent, subscription, customer email/phone) are never
two-way (DB check + service). External status **never** approves, schedules or publishes anything.

| Field | Source of truth | Direction | Deleted externally | Access revoked |
|---|---|---|---|---|
| Task title / due / status | Relay | Relay → provider; two-way if mapped | Relay record kept, link *unavailable* | link *unavailable* |
| Task priority, description (safe summary) | Relay | Relay → provider | — | — |
| Task assignee | Relay (explicit pick from the provider's people) | one-way | — | — |
| HubSpot ticket subject / priority / stage at creation | Relay | once, Relay → HubSpot; stage/owner shown from HubSpot | link *unavailable* | link *unavailable* |
| Relay case state | Relay | never changed by HubSpot | — | — |
| HubSpot contact link | person who links | explicit, audited, reversible; not consent | link *unavailable* | link *unavailable* |
| Google local post text | approved Relay revision | Relay → Google at the scheduled time | delete in Google | — |
| Google reviews / owner replies | Google | Google → inbox (stream B) | customer reviews are never deleted | paused |
| Mailchimp draft | approved Relay revision | Relay → Mailchimp, draft only | link *unavailable* | link *unavailable* |
| Mailchimp audience members | Mailchimp | **never** written by Relay | — | — |

**Loop prevention:** pulls never enqueue pushes; each push stores the hash of what the provider then reports, so its webhook
echo is recognised and dropped (`echo`); Relay-created records carry the origin marker (`relay:<job id>`: Asana
`external.gid`, monday first update, HubSpot description token, Mailchimp internal title) used to reconcile an *unknown*
create instead of repeating it. **Conflicts** (Relay has unsynced edits and the provider changed the same field) follow the
mapping's rule — *ask a person* by default; never last-write-wins.

**Durability:** business writes are `integration_sync_jobs` with deterministic idempotency keys (one ticket per case, one
draft per post, one task per create request), leased, retried with backoff (Retry-After honoured; rate-limit observation
stored), *unknown* on a lost response (reconciled, never resent), *failed* with a safe reason. Paused/disconnected
installations never run. Tasks and Google posts are tracked in their own tables (several per Relay item), other records in
`external_links` (+ `external_link_snapshots` for status shown in Relay).

## Per connector
- **Asana / monday.com** — create from a post, campaign, conversation, case or listening alert (permission of that object:
  content.edit / inbox.read / cases.manage / listening.read, plus integrations.read). The dialog shows exactly what leaves
  Relay (title, safe summary with a sign-in Relay link, due, priority) and what does not (customer messages, contact
  details, internal notes). Link an existing task by URL/id; refresh; unlink (external task untouched). monday status labels:
  *Done* ⇄ done, *Working on it* ⇄ in progress, anything else ⇄ open (columns are chosen in the mapping editor).
- **HubSpot** — exact-email or text search with masked emails; explicit contact ↔ customer link (audited, reversible; says
  nothing about marketing consent); case → one ticket (pipeline/stage defaults per installation, owner explicit, linked
  contact associated); an approved summary as a ticket note (exact text, one note per distinct text). Requires a Service
  Hub-enabled portal for tickets.
- **Google Business Profile** — explicit location selection; metrics (28 days, explicit refresh, stored); local posts from a
  post's schedule: at most 10 locations per request **and** the person retypes the count. Text = the scheduled revision's text
  (≤ 1,500 chars). The worker re-runs the publishing approval gate for that exact schedule (revision + fingerprint, current
  policy, approvers still eligible) and the requester's authority when due; changed content ⇒ *Needs review*,
  cancelled/rejected ⇒ *Cancelled*. Chat is discontinued (July 2024) and not offered.
  **Interface for stream B (reviews):** `listGbpLocations(ctx, { brandId })` → `{ integration_id, resource_id, brand_id,
  location_name: 'accounts/{a}/locations/{l}', title, is_simulated, access_state }` (also `GET /api/connectors/gbp/locations`);
  `openGbpConn(integrationId)` → `{ t, token, simulated, … }` for `reviews.list/updateReply/deleteReply` (simulated installs get
  the simulated transport); `onGbpNotification(fn)` receives verified Pub/Sub review notifications
  (`{ integrationIds, notificationType, locationName, reviewName, messageId }`). Review replies go through `requestReply`.
- **Cloud Translation** — off until a workspace admin turns it on **and** acknowledges per-character billing; a separate switch
  allows customer messages/reply drafts; monthly character cap; optional glossary. Links, @mentions, #hashtags, `{{placeholders}}`,
  `%merge%` tags and the brand name are protected (`translate="no"`) and restored byte-for-byte. Results are labelled
  *Machine translated* with source → target (detected or given) and keep the original; identical requests reuse the stored
  translation. Reply drafts: the exact outgoing text is shown for review and copied — never inserted or sent automatically.
  Cost estimate = characters sent × list price (USD 20 per million, checked 2026-11-08; configurable; the 500k free tier is
  **not** subtracted, so estimates never understate cost). The simulated API does not translate — it returns
  `[Simulated → xx] <original>`.
- **Slack** — channel alert routes: categories (approvals, assignments, connection, publishing, care escalations, listening,
  daily summary), brand filter, quiet hours (deferred, not dropped), max per hour (delayed), daily summary time. Assignments
  and care escalations only to **private** channels (privacy + app membership confirmed with Slack when saving). Messages are
  minimal (category + brand + Relay link). One message per event per route (in-app notifications feed + inbox hooks
  `case.changed`, `listening.alert_fired`). Approve buttons carry an opaque id; the server-side binding (approval, revision,
  fingerprint, 72 h expiry, single use) is checked by the normal approval service as the **linked** Relay person, with their
  current membership and permissions; changed content ⇒ "review in Relay". Unlinked Slack users get a one-time link (10 min)
  to confirm in Relay; nothing is matched by name or email. Reject needs a reason, so it opens Relay. Delivery history keeps
  sent / deferred / failed / *not confirmed* (a lost Slack response is never resent).
- **Mailchimp** — select audiences; *Create email draft* from a post whose schedule passed scheduling/approval (gate re-run);
  preview states that nobody is subscribed and nothing is sent; one draft per post; status + report refresh; link a Relay
  campaign to an existing Mailchimp campaign. The client refuses send/schedule/test/member endpoints outright. Audience
  webhooks are recorded only (Relay keeps no audience copy, so unsubscribe/suppression stay authoritative in Mailchimp).

## Automation actions (stream E)
`asana.create_task`, `monday.create_item`, `hubspot.create_ticket`, `slack.post_message` run through the same rules as the UI
(single selected project/board or an automation default; one ticket per case; Slack via care-escalation routes).
`mailchimp.create_campaign_draft` is not offered to automation: drafts come only from approved posts.

## Workload + worker
Sync jobs and inbound events: foundation `integration-sync` queue (bulk pool, deferred under publishing pressure).
`registerIntegrationWorkers` (one call in `apps/worker/src/main.ts`) adds: Google post dispatch (30 s), Slack alerts →
summaries → delivery (10 s, `notifications` class), task polling fallback (5 min, ≤ 20 tasks). The web process registers the
GBP and Mailchimp verifiers through the webhook route.

## Permissions
| Action | Permission |
|---|---|
| See hub / installations / history | integrations.read |
| Connect, configure, resources, mappings, pause, disconnect, Slack routes | integrations.manage (brand or workspace scope; MFA per policy) |
| Translation workspace control | integrations.manage at workspace scope |
| Task from post/campaign · conversation · case · listening | content.edit · inbox.read · cases.manage · listening.read (+ integrations.read) |
| HubSpot contacts / tickets / notes | inbox.read (search) · cases.manage (link, ticket, note) |
| Google local posts | content.schedule |
| Mailchimp draft | content.schedule |
| Translate | inbox.read (message) · inbox.reply (draft) · content.edit (post text) · listening.read (results) |

## Retention
| Data | Kept |
|---|---|
| Translations (text + usage) | workspace lifetime (usage is the cost record); erased with the workspace |
| Slack deliveries + actions, link tokens | deliveries/actions with the installation; link tokens expire in 10 min (single use) |
| External snapshots | replaced on each refresh; deleted with the link |
| Simulated provider objects | dev/demo only (`integration_sim_objects`) |
| Raw webhook bodies / activity | foundation: 7 / 30 days |

## Sources (checked 2026-11-08)
Asana OAuth + scopes: developers.asana.com/docs/oauth, /docs/oauth-scopes · monday.com items/webhooks:
developer.monday.com/api-reference/reference/items · HubSpot OAuth: developers.hubspot.com/docs/api/oauth-quickstart-guide ·
GBP local posts: developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts · Cloud Translation pricing:
cloud.google.com/products/translate/pricing · Mailchimp webhooks (signature format): mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/ ·
Slack OAuth v2 / request signing: docs.slack.dev. Re-verify monday's current API version (`MONDAY_API_VERSION`, default 2026-04)
and HubSpot note/association scopes against the live developer accounts at activation.
