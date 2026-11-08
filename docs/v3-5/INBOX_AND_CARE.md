# Inbox and customer care — foundation behaviour

What is built in the foundation stream (Facebook Page adapter on the simulated transport) and how it behaves. Other
networks: `docs/v3-5/CAPABILITY_MATRIX.md`.

## Channels
- Settings → Inbox → Channels: "Add <Page>" opts a connected Facebook Page into the inbox (`inbox.manage`). Publishing access
  never implies messaging access: the channel shows **Permission missing** until the Page's stored grant includes
  `pages_messaging`, `pages_manage_engagement`, `pages_read_user_content`. Live logins request those scopes only when
  `META_REQUEST_INBOX=true` (set after Meta App Review). Simulated Pages (`mock_`) are labelled *Simulated* everywhere.
- Live inbound: `POST /api/webhooks/meta` (X-Hub-Signature-256 with the app secret) → persisted + deduplicated → inbox.
  Simulated inbound: Settings → Channels → *Simulate* (dev/demo only; refused in production).

## Replying
- Modes: **Private message** (Messenger DM, or one private reply to a comment within 7 days), **Public reply** (comment
  replies), **Internal note** (team only; separate table; never sent). Switching mode keeps the text and never sends.
- Send-once: each send has an idempotency key; the server checks the thread version the agent saw *when they started
  writing*. If anything changed (another agent replied or is sending, a customer wrote, a reply was sent outside Relay) the
  send is refused with what changed; the agent reviews and sends explicitly. Only one send can be in flight per conversation.
- At dispatch the worker re-checks: sender still has `inbox.reply`, channel active, conversation not spam, reply window
  (24 h for Messenger; Human Agent 7 days only with `META_HUMAN_AGENT_APPROVED=true`), no outside reply since queuing.
- Results shown on the message: *Sent* (provider message id stored), *Delivered*/*Read* only from Meta receipts, *Not sent*
  with Meta's reason, *Not confirmed* when the response was lost — Relay looks the message up; if it can't confirm, a person
  chooses *It was sent* / *Not sent*. Nothing is resent automatically.

## Queues
Unassigned (open, no assignee) · Mine · Team (assigned to one of my teams) · Waiting · Snoozed (returns automatically) ·
Resolved · Spam · All. A customer message reopens resolved/waiting/snoozed conversations.

## Cases and service levels
- Create a case from a conversation; one conversation belongs to at most one case.
- Definitions (also returned by `GET /api/inbox/report`): clock starts at the earliest unanswered customer message (else
  creation); first response = first provider-confirmed reply (notes never count; automated acknowledgements only if the
  policy allows); the clock pauses while *Waiting on customer* or *Resolved*; only business hours count (holidays have none;
  no hours = 24/7); reopening resumes the resolution clock and is counted; first response is not re-measured.
- Breaches are recorded once by the worker and the case owner is notified (no message text in notifications).
- Resolve needs a reason. Case changes use optimistic concurrency (stale version ⇒ 409).

## Permissions
| Permission | owner/admin | brand_manager | care_agent | editor | viewer |
|---|---|---|---|---|---|
| inbox.read | ✓ | ✓ | ✓ | – | – |
| inbox.reply | ✓ | ✓ | ✓ | – | – |
| inbox.assign | ✓ | ✓ | ✓ | – | – |
| cases.manage | ✓ | ✓ | ✓ | – | – |
| inbox.manage (channels, SLAs, saved replies) | ✓ | – | – | – | – |
| integrations.read | ✓ | ✓ | ✓ | – | – |
Platform operators get nothing implicitly; Admin → Inbox health shows counts and states only.
