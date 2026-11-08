# Lead notes for stream F / copy cleanup (V3.5)

- Automation rule test preview lists every non-matching message ("No match · Other" × 20). Show matches, collapse the rest
  into "23 didn't match" (expandable).
- Main nav is now long (Inbox, Listening, Assistant, Tasks, Integrations + admin group). Consider grouping (e.g. "Engage":
  Inbox, Listening; "Workspace": Integrations, Team, Settings) or moving Integrations under Settings — decide in copy
  cleanup / IA pass with the user.
- E pending wiring: `listening.alert` trigger (D hook), `content.approved` trigger (collab event bridge), C executor kinds
  `slack.post_message`, `asana.create_task`, `monday.create_item`, `mailchimp.create_campaign_draft`, `hubspot.create_ticket`
  (web + worker).
- Open user decision: Inbox in the phone bottom bar for inbox users (lead recommends replacing Planner for them).
- Integrations hub: simulated installs show a green "Connected" + "Simulated" — use one badge "Simulated" (neutral) for
  simulated installs; keep green "Connected" for live ones. Card badge placement is inconsistent (beside name vs wrapped):
  put status on its own line under the name on every card.
- Connector "Needs app setup" shows env var names (ASANA_CLIENT_ID…) and redirect/webhook URLs to workspace users. Show
  those only to instance owners/platform operators; others see "Ask your Relay admin to set up Asana".
- C kept a one-line import in E's automation/rules.ts (accepted). `mailchimp.create_campaign_draft` intentionally not
  registered (drafts only from approved posts) — E's UI should hide that action rather than show "Not available yet".
- Pre-existing overflow at 320/360 px on a published post's deliveries panel (long connection id, tz labels) — fix in F.
- Worker needs one rebuild + restart after all streams (C's automation executors not in the running worker).
- D emits `listening.alert_fired` (outbox → inbox-events; payload { ruleId, searchId, brandId, simulated, origin }). Bind E's
  `listening.alert` trigger and C's Slack alerts to it via `onInboxEvent('listening.alert_fired', …)` (stream F).
- D admin overview `GET /api/listening/admin` + MCP listening tools → stream F.
- B: echo detection drops any inbound body containing `relay:<uuid>` (so a customer message quoting one is dropped). Scope
  echo detection to provider fields Relay writes (metadata / external_id / own-sender), not free text — stream F.
- B: foundation `removeChannel` doesn't release a Telegram bot webhook; make remove call the release path (only if the
  webhook is still Relay's) — stream F.
- B ↔ C: GBP Pub/Sub verified handler should call `pollChannel(channelId)` for review notifications — confirm wired (F).

## Stream F — status of the notes above (2026-11-08)
- DONE rule-test preview: matches listed, non-matches collapsed into "N didn’t match" (expandable).
- PROPOSAL (not applied) main nav: see `docs/v3-5-progress/final.md` → "Nav proposal" (decide in the copy/IA pass).
- DONE `listening.alert` trigger (bound to `listening.alert_fired`) and `content.approved` trigger (bridge: collaboration
  consumer turns `approval.decided`/approved into outbox `content.approved`). C executor kinds slack/asana/monday/hubspot
  are registered in web + worker (worker rebuilt); alert/approval triggers allow `notify` (chosen people) + slack/asana/monday.
- OPEN user decision (recorded only): Inbox in the phone bottom bar for inbox users.
- DONE hub: simulated-only installs show one neutral "Simulated" badge; green "Connected" only for live installs; status on
  its own line under the name on every card; installation header shows only "Simulated" for an active simulated install.
- DONE setup details (missing keys, redirect/webhook URLs) only for the instance owner (setup.manage in the primary
  workspace in production) and platform operators; others: "Ask your Relay admin to set up <name>." (redacted server-side).
- DONE `mailchimp.create_campaign_draft` hidden in the action picker (kinds without an executor are not offered).
- DONE 320/360 overflow on a published post's deliveries panel (absolutely positioned sr-only text escaped the truncation).
- DONE worker rebuilt + restarted with all streams.
- DONE Slack listening alerts + automation bound to `listening.alert_fired` (Slack: loads the alert, links
  `/listening/alerts/:id`, simulated alerts only to simulated Slack installs).
- DONE admin listening overview → Admin → Inbox, listening and AI → Listening coverage; MCP listening tools.
- DONE echo detection: only Relay-written provider fields (Asana `external`, monday update text, Slack message metadata)
  AND the marker must name a sync job Relay really ran for that installation; customer free text is never an echo.
- DONE Telegram `removeChannel` releases the webhook first (only if it is still Relay's); secret cleared; audit records it.
- DONE GBP Pub/Sub → `pollChannel` (it was NOT wired: no listener was registered; now `inbox/channels-gbp-notify.ts`).
- DONE (lead message) WhatsApp template fields "Value 1" (+ Meta's example values when provided; preview shows "[Value n]");
  classification line "Other · unsure · positive"; context panel "Answered · <time>" / "Waiting since <time>".
- DONE (lead nit) human durations everywhere in admin via `duration()` in `components/admin/ui.tsx` ("45 s", "12 min",
  "3 h 20 min", "14 d"): Inbox health, V3.5 overview, Integrations and sync, Platform health, Collaboration pipeline,
  Queues and workers, Support access.
- DONE (lead nit) Automation shows where it lives: breadcrumb "Assistant / Automation" above the title (Assistant keeps its
  "Automation" button); main-nav restructuring stays with the IA proposal.
