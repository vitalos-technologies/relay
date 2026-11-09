# AI tools and execution model (V5, stream AIW)

Brief §11–16. Code: `packages/services/src/ai-workflows/**` (engine, workflows, actions, context, suggestions, admin),
`packages/services/src/assistant/**` (V3.5 client, retrieval, guard — reused), contract `packages/core/src/contracts/v5-ai.ts`,
migration `packages/db/migrations/038_v5_ai_runs.sql`, UI `apps/web/components/ai-workspace/**` at `/assistant`.

## 1. One run system
A workflow run is an `ai_runs` row with `kind='workflow'` — the same table, outbox event (`ai.run_requested`), queue
(`ai-assist`, workload class `ai_assist`, bulk pool), model client, structured output schema, budget meter (`ai.tokens`
reservations + `ai_usage` ledger), retrieval and output checks as the V3.5 single-task assistant. The worker's
`executeRun` hands workflow rows to the workflow engine. Pages never wait for a model: `POST /api/assistant/workflows`
only queues; the page polls `GET /api/assistant/workflows/:id?after=<seq>` for new events (small responses; typing and
scrolling stay responsive). Status: implemented, integration-tested.

| Table | Holds |
|---|---|
| `ai_threads` | A person's conversations (history sidebar), private to them; keyset-paginated |
| `ai_runs` (+columns) | `kind`, `thread_id`, `title`, lifecycle `status`, `outcome_code`, `pending_input`, `cancel_requested_at`, `deadline_at`, `last_event_seq` |
| `ai_run_steps` | The persisted plan: key, kind (read · validate · model · write · external), status, Relay-written detail, result (ids/counts; model output kept 30 days) |
| `ai_run_events` | Short observable progress lines ("Reading the selected brief.", "Saved 2 drafts.") — never model reasoning |
| `ai_run_results` | Structured result cards linked to real records (post, campaign, conversation, analytics) |
| `ai_attachments` | Composer attachments (text/Markdown/CSV/JSON ≤ 256 KB), private, untrusted, purged after 30 days |
| `ai_proposed_actions` (+kinds) | Prepared external actions `schedule_post`, `submit_for_approval`, `send_reply` with `bound_hash` / `confirmed_hash` / `result` |

## 2. Lifecycle
`preparing → working → needs_input / needs_review → completed / partially_completed / failed / cancelled`.

- **preparing**: queued; steps already visible. **working**: leased by a worker (3 min lease, renewed per step).
- **needs_input**: a step asked a question built by Relay (e.g. "None of the chosen accounts is ready — choose
  destinations", "“X” is not approved material. Use it anyway?"). Answers must be one of the offered options.
- **needs_review**: internal work is done and required external actions wait for the person's review.
- **completed / partially_completed / failed / cancelled**, with `outcome_code`: `not_configured`, `budget_exhausted`,
  `blocked` (access revoked), `entitlement`, `timeout`, `step_failed`, `cancelled`, `interrupted`.

Guarantees (each covered by `tests/integration/v5-ai-workflows.test.ts`):
- **Refresh / disconnect safe**: all state is in the database; events are fetched by sequence cursor.
- **Current access**: every execution re-loads the requester's membership and grants; revocation stops the run before
  anything is read. Plan features are re-checked at run time.
- **Safe retry / resume**: read and validate steps re-run (they re-check access); model and write steps with a persisted
  result are reused (no second charge, no duplicate records). Writes use deterministic idempotency keys
  (`ai-<run>-<step>-<item>` through the posts service), so a crash between a save and its bookkeeping cannot duplicate.
  An expired lease is picked up by the sweep (every 15 s) and resumed.
- **Cancellation**: "Stop" before a worker claims the run cancels immediately; while working, the run stops at the next
  checkpoint (between steps and between items). The final message lists what was already saved and kept; pending
  proposals are dismissed; nothing is published or sent.
- **Timeouts**: every run has a deadline (15 min); the engine checks it per step and the sweep finalizes runs past it.
- **Partial results**: per-item failures are reported on the card and in events; the run ends `partially_completed`.

## 3. Workflows (§14)
| Workflow | Plan feature | Deterministic steps (run without AI) | Model steps | Records created |
|---|---|---|---|---|
| Campaign from a brief | `ai_workflows` | read the selected source (document, approved knowledge, attachment, post); check destinations (ready, not paused, publishing available); create the campaign | outline; one draft per channel (provider limits in the task) | campaign, one draft post per channel (linked to the campaign); optional submit-for-approval previews |
| Inbox assistance | `ai_workflows` | read selected conversations (inbox.read); triage per conversation (category, urgency, sentiment estimate, waiting since); flag missing information (e.g. no order number); flag instruction-like text | issue summary + reply draft per conversation | reply previews (`send_reply`) + "put in reply box"; nothing is sent by the run |
| Performance analysis | `ai_workflows` | query stored analytics (analytics.read) for 7/28/90 days vs the previous period; report with period, time zone, coverage, "data complete through", demo-data label, Relay's calculated insights as evidence | explanation of observed changes; up to 3 next steps | report card with a working analytics link; "Create task" offers (existing task service) |
| Weekly planning | `ai_workflows` | read the week's calendar (scheduled + pending approval); find unscheduled ready drafts (approved first); validate them; flag same-account conflicts < 1 h and missing images; propose times on posting slots (or disclosed default 10:00 weekdays) | drafts for empty slots | new drafts; `schedule_post` previews per item (scheduled directly or submitted for approval per the brand's policy) |
| Content adaptation | `ai_workflows` | read the source — for a post, the latest **approved revision**, never the working draft (unapproved material needs an explicit "use anyway"); extract facts to preserve (numbers, dates, prices, links); check destinations | one version per channel | new draft posts (the source is never overwritten); "Compare versions" against the source; missing facts flagged |
| Ask | `ai_drafting` | read brand voice + chosen approved knowledge + attachments | answer or copy with verified evidence | none |

## 4. AI without a provider key
No key exists in this environment. Deterministic steps run for real; model steps are recorded `not_configured` with
"AI is not set up"; the run ends `partially_completed` (something useful was done) or `failed` with
`outcome_code=not_configured`. No placeholder, fixture or fabricated text is ever shown. `Ask` (a single model step) is
refused up front (`provider_not_configured`). Tests inject a fake provider with `setAssistantModelClient` (tests only).

## 5. Action policy (§15)
- Reads, drafts and internal saves (draft posts, campaigns, tasks) proceed without repeated confirmation, through the
  normal services with the requester's own context (same permissions as the UI).
- External actions are only **prepared**. `GET /api/assistant/actions/:id/preview` returns the exact destinations,
  content per destination, timing, approval requirement, whether the person may do it, and a hash of that state.
  `POST /api/assistant/actions/:id/apply {reviewed_hash}` re-builds the preview; any change (post edited, new customer
  message, time passed) ⇒ `409 conflict` and a fresh review. Then the normal service runs — `schedulePost` /
  `submitForReview` (permissions incl. MFA, approval policy, brand rules, entitlements, post version) or `requestReply`
  (inbox.reply, channel rules, thread changes) — with idempotency key `ai-action-<id>`: a repeated confirm cannot act twice.
- The assistant cannot bypass approvals: on approval-required brands scheduling becomes a submission for review.
- Runs have no browser session, so a step checks permissions grant-wise when preparing (`holdsPermission`); session
  assurance (MFA / fresh sign-in) is enforced by the service when the person confirms.
- Source documents, attachments and customer messages are untrusted: quoted as data with their trust level, injection
  attempts counted and reported, links/numbers in generated text checked against the sources. Targets and parameters of
  every prepared action come from Relay's own context, never from model text.
- Result cards: Open draft, Edit (inline, versioned save with conflict copy), Compare versions, Review reply, View report,
  Submit for approval, Review schedule, Create task, Open conversation / campaign.

## 6. Suggestions (§12)
`buildSuggestions()` (pure) uses the server-built context for the person and brand: ready accounts, documents/knowledge/
attachments, posts (approved first), unanswered conversations (inbox.read), stored analytics (analytics.read), plan
features and AI configuration. Rules: never prefill an account that is not ready (default: one ready account per network,
max 5); no analytics suggestion without stored data; no listening suggestion (no listening workflow; never analysing
unavailable data); multi-step suggestions need `ai_workflows`; `Ask` suggestions only when AI is set up. Each suggestion
carries the reason it is shown and a prefilled task; clicking fills the composer and its task-specific details panel.
Free text is mapped to a task type by a fixed keyword rule (`guessWorkflow`), shown as an editable chip.

## 7. Entitlements and usage
Multi-step workflows require `ai_workflows` (Professional, Legacy); Standard keeps `ai_drafting` (Ask, V3.5 drafting).
Checked at request and again at run time (`checkFeature`, paid action). Model calls reserve from the `ai.tokens` meter
(workspace cap, team budgets, plan ceilings) and are recorded in `ai_usage` with the run id; an exhausted budget stops the
run with `budget_exhausted` and keeps what was done.

## 8. Admin (§16)
- Workspace admin → AI and automation (`/admin/ai`, diagnostics.read): plan + provider state, AI drafting / workflows
  availability, budget meter (cap changed in Usage and limits), 30-day model calls/tokens/cost estimate, runs by workflow
  (7 days), recent failures with the failed step and Relay-written outcome text, requester. No prompts or content.
- Platform → AI operations (`/admin/platform/ai`, any platform role): runs by status/workflow, outcome codes, failed step
  keys, most active workspaces with failures/budget stops/tokens. Metadata only (tested: no titles or document text).
- Audit: `ai.workflow_requested`, `ai.workflow_finished`, `ai.workflow_cancel_requested`, `ai.workflow_retried`,
  `ai.workflow_record_created` (per saved draft), `ai.attachment_added`, `ai.action_confirmed`, `ai.action_dismissed`.

## 9. API
| Method | Path | Notes |
|---|---|---|
| GET | `/api/assistant/workspace?brand_id=` | Context + suggestions |
| GET | `/api/assistant/threads?cursor=&limit=` · `/threads/:id` · PATCH `{title?, archived?}` | History |
| POST | `/api/assistant/workflows` `{workflow, thread_id?, prompt?, inputs, idempotency_key}` | Queue a run |
| GET | `/api/assistant/workflows/:id?after=` | Run + events after cursor |
| POST | `/api/assistant/workflows/:id/cancel` · `/retry` · `/input {field, value}` | Control |
| GET/POST/DELETE | `/api/assistant/attachments` | Text attachments |
| GET | `/api/assistant/actions/:id/preview` · POST `/apply {reviewed_hash}` · `/dismiss` | External action review |
| GET | `/api/assistant/admin` · `/api/platform/ai` | Admin |

## 10. Retention and privacy
Generated result text, persisted model output and attachment text: 30 days (hourly purge with V3.5 run output). Steps,
events, ids, counts, usage and audit are kept. Threads are private to their owner; runs are visible only to the requester
while they can still see the brand. Prompts are not logged; the person's request text is purged with run output.

## 11. Gaps / activation
- Activation: an AI provider key (Setup) plus `AI_MODEL` (server environment; no default, D32) turns on model steps; budgets per workspace in Usage and limits.
- Progress uses polling with an event cursor (no server push); attachments are text formats only (larger documents via
  the Content library); a model call in flight cannot be aborted mid-request (cancellation applies at the next checkpoint).
