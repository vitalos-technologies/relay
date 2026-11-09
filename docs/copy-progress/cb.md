# Copy cleanup — stream CB (engage, insights, business)

Status: done (pending lead review). Copy/presentation only — no route, validation, auth, event, API field or persisted
value changed. Help Centre content, docs and the widget's privacy text untouched.

## How screens were inspected
Scratchpad Playwright script with short-lived session rows (same approach as `scripts/v4-final-shots.mjs`): rendered
`<main>` text + dialogs + aria-label/title/placeholder dumps before and after editing, screenshots 1440/390 light/dark,
and page-level horizontal-scroll checks at 320/360/390/430. Data: "E2E Workspace" (populated), "Demo Workspace" (empty
states: no inbox channels, no listening sources), "E2E Billing" (trial billing), Demo Workspace (legacy billing). Every
string in the owned component folders was also extracted from source (TypeScript AST) and reviewed, so states that are
hard to reach rendered (errors, permission-denied, disconnected, not configured) were reviewed in source.

Rendered: Inbox (list, thread, mobile thread, Assistant drawer "AI is not set up"), Settings → Inbox channels / service
levels / saved replies, Listening (overview populated + empty, search, alert, mention, compare), Settings → Listening
sources, Assistant (AI workspace), Automation, Analytics (overview, content, channels, audience, video, workflow),
Integrations hub + Asana / Slack / HubSpot / Google Business Profile, Help (Contact support, My requests, request
detail), Settings → Plan and billing (trial + legacy), Usage and limits, Inbound sources, MCP (settings + /mcp/settings),
support widget (visitor + signed-in member, marketing page).
Not rendered (source review only): MCP consent (/mcp/connect) and intent confirmation (/mcp/confirm), listening
dashboard detail (no dashboard in data), checkout test pages, WhatsApp template/Telegram dialogs, past-due/suspended
billing banners, connector OAuth error returns.

Finding: these areas were already terse (earlier passes applied the same standard). Most remaining text is essential
(billing amounts/consent, privacy, analytics definitions/coverage, connection limits, simulated vs live, AI-not-set-up
honesty) and was kept. Changes target real redundancy, developer notes and jargon.

## Before → after
- Assistant: intro "Relay reads your brand’s content and data, drafts and plans, and prepares anything external for your
  review." → removed (title + suggestion cards say it; review step is shown where it happens).
- Assistant "AI is not set up": "Data steps still run for real — reading, checks, plans and reports. AI-written parts are
  skipped. An owner can add…" → "Data steps (reading, checks, plans, reports) still run; AI-written parts are skipped. An
  owner can add a provider key in Setup."
- Assistant history empty: "Your tasks will appear here." → "No tasks yet".
- Integrations connector page: Redirect URI, Webhook URL and "Docs checked" (operator details) → collapsed under
  "Setup details"; permissions requested and "Before you connect" (limitations) stay visible.
- Duplicate simulated labels: "Asana (simulated) [Simulated]", "E2E Inbox Page (simulated) [Simulated]" → the badge is
  dropped only when the name already says "simulated" (connector installation, inbox channels, listening sources).
  Listening mention source "… Page (simulated) (simulated)" → "… Page (simulated)".
- Settings → Inbox → Channels: card "Channels in the inbox" (repeats page title) → "Connected"; empty "No channels in the
  inbox yet" → "No channels yet" (matches the Inbox empty state); tooltip repeating the visible footnote removed;
  footnote "Built and testable with simulated accounts. Live use needs the network’s approval first." → "…; live use
  needs the network’s approval."; Add channel dialog description "Pick a network, then the account to use in the inbox."
  → removed.
- WhatsApp: "Template messages are charged by Meta per delivered message. Replies inside 24 hours…" → "Meta charges per
  delivered template message. Replies within 24 hours of the customer’s message are free."; rate card paragraph
  shortened (same meaning); template dialog description "Approved templates can be sent at any time." → removed (kept
  the out-of-window rule).
- Listening sources: "Xinbox adapter not built yet" (jargon, run-on) → "X · not available yet"; broader sources
  paragraph rewritten and the "None is active" clause now only shows when none is active.
- Listening: "No saved dashboards." → "No dashboards"; empty overview "Add a channel to the inbox to start collecting
  public comments and reviews." → "Add an inbox channel to collect public comments and reviews."
- MCP: compatibility notes "Not runnable in the build environment. Activation item." / "In-repo protocol test against
  the real handler: …" / "The pinned SDK 1.32.2 negotiates …" → empty where the "Not tested" badge says it all,
  "Protocol test passes: discovery, tools, resources, prompts, sign-in refusals, publishing.", "Supported versions: …";
  card "MCP endpoint" → "Endpoint".
- Billing: "Confirming…" body "Your plan updates as soon as the provider confirms payment." → "Your plan updates once
  payment is confirmed."; "Not confirmed yet" body shortened.
- Inbox: "This conversation could not be loaded" → "Couldn’t load this conversation"; "Service levels saved" →
  "Saved"; Telegram dialog description tightened; "Not checked yet." → "Not checked".

## Files edited
- apps/web/components/inbox/{channels-settings,settings,thread,whatsapp-template-dialog}.tsx
- apps/web/components/listening/{mention-detail,overview,sources-settings}.tsx
- apps/web/components/assistant/assistant-app.tsx
- apps/web/components/ai-workspace/{workspace,history}.tsx
- apps/web/components/integrations-hub/connector-page.tsx
- apps/web/components/billing/billing-settings.tsx
- apps/web/components/mcp/developer-settings.tsx
- packages/services/src/mcp/setup.ts (display notes of the MCP compatibility table only)
No shared UI / shell / lib/client files edited. No test assertions needed changing.

## Requests for the lead / other streams
- Analytics footnotes come from the server (`packages/services/src/analytics/query.ts`: "Numbers are network-reported
  and refreshed in the background; they are not real-time.", workflow note "App-owned workflow facts for the selected
  scope. …"). Left as is (definitions/freshness); could be shortened to "Network-reported, refreshed in the background —
  not real-time." / drop "App-owned workflow facts for the selected scope." if the lead wants.
- Connector health message for simulated installs ("Simulated connection.") comes from the server and repeats the badge.
- Platform-only components in CB folders (`billing/platform-billing-panel`, `entitlements/platform-entitlements`,
  `ai-workspace/admin-workflows`) render in the admin app (CC) and were not changed.

## Shared host
Started Docker + infra after the container restart (under the lock). Rebuilt web twice under the lock and restarted the
:3000 server (the running one had been started by another stream; `.data/web.pid` updated).

## Verification (2026-11-08)
- `pnpm -s typecheck`: clean. `pnpm test`: 45 files, 624 tests passed.
- Integration (20 files covering inbox, inbox-more, listening, AI/automation, integrations, connectors, MCP, billing,
  entitlements, support, AI workflows, widget, analytics, TipSignal): 229 tests; 228 passed in the parallel run, the one
  failure was the listening load-timing assertion under parallel load (6050 ms vs 3000 ms) — rerun alone: 10/10 passed.
- E2E (inbox, inbox-more, listening, ai-automation, integrations, v35-final, v4-billing, v4-entitlements, v4-support,
  v5-ai, v5-widget): 49 passed, 7 skipped, 1 failed — v35-final admin counts compared `oldest_unanswered_minutes`
  2410 vs 2409 across a minute boundary (timing, not copy); v35-final rerun: 3 passed, 1 skipped.
  (A first run without the worker failed the inbox send/classification tests; the worker was then started by another
  stream and the rerun above is with it.)
- No page-level horizontal scroll at 320/360/390/430 on 37 CB screens.
- Screenshots: `evidence/copy/cb/<screen>-{1440,390}-{light,dark}.png` (inbox, settings-channels, listening,
  listening-mention, assistant, integrations-asana, settings-mcp, settings-listening-sources, settings-billing, widget).
