# Relay AI assistant and automation — behaviour guide (stream E)

Brief §16–18. Code: `packages/services/src/{assistant,automation}/**`; contracts `packages/core/src/contracts/v35-{ai,automation}.ts`;
migration `032_v35_ai_automation.sql`. Status of provider access: see the activation checklist in `docs/v3-5-progress/ai-automation.md`.

## 1. Assistant
**Where:** Composer (draft/adapt copy, translate, brief, ask), Inbox composer toolbar (summarize, suggest reply, labels +
priority, translate, ask), Planner and Content library (brief, copy, ask), Analytics (explain observed numbers, insight →
draft/task), Listening searches (summarize mentions with evidence + coverage, insight → draft/task), and `/assistant`
(Ask, History, Knowledge).

**What it does:** reads authorized data, explains, drafts, suggests and prepares actions. It never sends, publishes,
exports or changes CRM/external records. Proposed actions (put a reply draft in the reply box, add labels, set priority,
add an internal note, use copy, create a task) are previews the requester applies through the normal service with their
own permissions.

**Off when not configured:** with no provider key (Setup) or no `AI_MODEL` (environment, D32) the assistant says "AI is not set up"; no run is created and no
output is shown. There is no fixture/demo output in the app (tests use an injected fake provider).

**Run lifecycle:** request (ai.use + the context's read permission, rate limit 20/10 min per person, monthly budget) →
`ai_runs` row (queued) + outbox `ai.run_requested` → `ai-assist` queue (workload class `ai_assist`, bulk pool) → worker:
re-load the requester's current access → scoped retrieval → token reservation → model call (structured output, no tools) →
checks → access re-check → persist. Outcomes: `succeeded`, `failed` (provider outage: recoverable, reservation released,
nothing invented), `refused`, `blocked` (access revoked / policy stopped), `budget_exhausted`, `not_configured`.

### Retrieval and permissions
| Context | Permission | Sources (trust) |
|---|---|---|
| Conversation | inbox.read on its brand | messages, oldest→newest, max 30 (untrusted); internal notes are never included |
| Post | brand access + content.read | title, base copy, own-text variants (Relay data) |
| Brand | content.read | brand voice (approved) |
| Analytics | analytics.read | overview KPIs with comparison + basis, demo flag (Relay data) |
| Listening search | listening.read (D's services) | latest 40 mentions (untrusted) + coverage (Relay data); DMs never included |
| + knowledge | content.read or inbox.read on the brand | approved Content Hub documents (latest snapshot, `linked` only) and saved replies (approved) |

Knowledge is approved per brand by a brand manager (`brands.manage`) with optional topics and a **review date**. Past its
review date a source is "stale": still shown, but never satisfies the "approved source" requirement for policy, prices,
refunds or commitments. Revoking removes it from every later run. Nothing is copied into a shared index.

### Prompt-injection resistance (acceptance test 11)
1. Authority: only Relay's system prompt and task block instruct. The person's request is quoted separately. Every source
   is wrapped `<source ref kind trust stale as_of>` with our delimiters neutralised (`<` → `‹`) and control/bidi characters
   stripped; instruction-like text is detected and counted ("A source contains instructions. They were treated as text").
2. Capability: no tools, credentials, SQL, shell or URL fetching. Proposed actions are an allow-list per task; Relay builds
   the action (target from its own context, labels sanitised, priority from a fixed set); the model cannot choose people.
3. Output checks (deterministic): a link must appear in a trusted source or the person's request (customer links never
   count); numbers must appear in the sources (automatic replies: in approved knowledge only); policy/price/refund/
   commitment wording without a current approved source is flagged; evidence quotes are verified verbatim
   ("Not found in source"); `answerable=false` ⇒ uncertain.

### Recorded per run (no prompts, no message bodies in logs)
Provider, served model, latency, input/output tokens, cost estimate (shared `ai_usage` ledger with `ai_run_id`), source
references (titles/ids/freshness/trust — no text), action trace (access, retrieval counts by kind, injections found,
model status, checks). Output (drafts/summaries) and the person's request text are purged after **30 days**; proposed
actions expire after 7 days.

## 2. Automation
### Policies (bounds) — `automation.manage` (owners/admins; MFA where required)
A policy names: brands, channels, allowed actions, approved knowledge (AI replies), message categories eligible for
automatic replies (refund, complaint, sensitive and spam are never offered), actions/hour, automatic replies/day, monthly
AI token budget, escalation (always refund/complaint/sensitive; negative sentiment; keywords; escalation team/person),
expiry (≤ 12 months) and review date. States: draft → active ⇄ paused, stopped, expired (automatic at expiry).
Activating makes you the **owner**: the policy's service actor acts with the owner's *current* permissions narrowed to
the policy's brands; losing access stops it. Editing an active policy pauses it. **Emergency stop** (workspace-wide) stops
all rules and cancels queued automatic replies; per-policy stop/pause cancels that policy's queued replies.

### Rules — When → If → Then
| Part | Options |
|---|---|
| Trigger | New customer message · Case nearing its deadline (sweep, N minutes before) · Case changed · Listening alert (needs D's alert hook — shown "not available") · Content approved (needs a collaboration bridge — "not available") |
| Conditions (all) | category, sentiment, urgency, assigned, first message, type, channel, language, priority, message contains, has label; case change; minutes to deadline |
| Actions | assign/route (person/team), set priority, add labels, internal note, create case, notify (in-app, content-free), escalate, reply with saved reply, AI reply from approved knowledge, integration action (Slack/Asana/monday/Mailchimp/HubSpot via `enqueueSyncJob`, only when C's executor exists) |
| Scope | brands and channels within the policy |
| Schedule | always / business hours / outside business hours (service-level calendar) |
| Limits | max runs per hour, per-conversation cooldown; plus policy limits |
| Test | dry run over the 25 latest conversations/cases in scope: shows matches and what would run/escalate; changes and sends nothing |
| History | every run: rule, trigger, subject link, outcome, reason, per-condition match (no values), per-action result |

### Order of work for a new customer message
1. Classify (deterministic: category, sentiment, urgency, language guess, instruction-like text, uncertainty) → stored.
2. Enabled rules of active policies covering the brand + channel, in position order; conditions.
3. One run per (rule, message) — repeated delivery never runs twice. Policy re-check, schedule, limits.
4. If an escalation signal is present and the rule would reply: escalate first (priority high, label `escalated`, route to
   the escalation team/person, internal note naming the reason — never the customer's text).
5. Actions via the inbox/case/connector services as the service actor, inside the automation origin.

### Automatic replies
- Saved reply: sends the approved text through `requestReply` (send-once, collision check, reply-window rules, automated
  flag). AI reply: queues an AI run restricted to the conversation, brand voice and the policy's current approved
  knowledge; sends only if the draft has **no** issues (links/numbers grounded in approved knowledge, no unsupported
  commitment, model said answerable) and the thread has not changed since the message (base version) — otherwise escalates.
- Never for refund/complaint/sensitive/spam, uncertain classification, instruction-like text, negative sentiment (if set)
  or escalation keywords; never beyond the daily cap; never when the policy is not active at **dispatch** (the reply worker
  re-checks every automated attempt against its policy and owner).
- Automated replies are marked on the message and count for first response only if the service-level policy says so.

### Loop prevention
Automation acts inside an origin context; every outbox event it causes carries `origin.kind = 'automation'` and is ignored
by automation. Runs are unique per (rule, event). Rate limits and cooldowns bound bursts. External writes carry the
connector origin marker so their webhook echoes are dropped (C). External status never approves or publishes.

## 3. Permissions
| Permission | owner/admin | brand_manager | care_agent | editor | analyst |
|---|---|---|---|---|---|
| ai.use (assistant) | ✓ | ✓ | ✓ | ✓ | – |
| approve knowledge (brands.manage) | ✓ | ✓ | – | – | – |
| automation.manage (policies, rules, stop, history) | ✓ | – | – | – | – |
Each assistant task additionally needs the context's own permission (inbox.read, content.read, analytics.read,
listening.read). Platform operators get nothing implicitly.

## 4. Data
`ai_knowledge_sources`, `ai_runs`, `ai_proposed_actions`, `ai_classifications` (signals only), `automation_settings`
(emergency stop), `automation_policies`, `automation_rules`, `automation_runs` (history; UNIQUE(rule_id, event_key)),
`automation_sends` (automated reply ↔ policy, checked at dispatch). `ai_usage.task` widened + `ai_run_id`.

## 5. Acceptance tests covered (brief §22)
- AT11 — `tests/integration/v35-ai-automation.test.ts`: authorized sources only (other brand's knowledge, other
  conversations, internal notes excluded; revoked knowledge excluded); embedded instructions neutralised and their
  planted link/commitment blocked; disallowed proposals dropped.
- AT12 — membership removal and grant revocation block queued runs before retrieval; owner removal blocks automation.
- AT13 — provider outage ⇒ `failed`, nothing invented, budget released, retry works; never executed twice.
- AT14 — run state read back through the API equals stored state (sources/usage/actions); MCP exposure is stream F.
- AT15 — mobile layouts for the assistant drawer, `/assistant` and `/automation` (E2E, pending the dev-host lock).
