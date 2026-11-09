---
title: Create Asana tasks from Relay
summary: Connect Asana, choose projects, create or link tasks from posts, campaigns, conversations, cases and listening alerts, and control two-way sync of title, due date and status.
section: business-apps
audience: user
roles: [owner, admin, brand_manager, editor, care_agent]
status: needs-setup
related: [business-apps-overview, monday-com, hubspot, slack]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [asana, task, project, two-way sync, webhook]
sources:
  - title: "Asana — OAuth scopes"
    url: https://developers.asana.com/docs/oauth-scopes
    verified: 2026-11-09
  - title: "Asana — Webhooks guide (at-most-once delivery, retries, X-Hook-Secret)"
    url: https://developers.asana.com/docs/webhooks-guide
    verified: 2026-11-09
---

## Before you start

- The workspace owner registers an Asana developer app (OAuth) in **Setup**.
- Relay requests `tasks:read`, `tasks:write`, `projects:read`, `users:read`, `workspaces:read`, `webhooks:write`
  (verified as valid Asana scopes on 2026-11-09). It never requests permission to delete tasks.

## Connect and choose projects

1. **Connections → Business apps → Asana** ([/integrations](/integrations)) → **Connect**; choose brand or workspace scope.
2. Sign in to Asana and approve.
3. **Resources** → select the **Projects** Relay may create tasks in.
4. Optionally **Sync rules** → **Add** a mapping (title, due date or status; direction; *When both changed*).

## Create or link a task

From a post or campaign (Composer → **Integrations** card), a conversation or case (Inbox → customer panel →
**External work**), or a listening alert:

1. Choose **Create task**, the project, and (optionally) an assignee picked from Asana's people.
2. The dialog shows exactly what leaves Relay — title, a safe summary with a sign-in link back to Relay, due date and
   priority — and what does not: customer messages, contact details and internal notes are never sent.
3. Or **link an existing task** by its URL or id. **Unlink** removes the link only; the Asana task is untouched.

## How sync works

| Field | Direction |
|---|---|
| Title, due date, status | Relay → Asana; two-way only if you mapped it two-way |
| Priority, description | Relay → Asana |
| Assignee | Relay → Asana only (explicit pick) |
| Approval / publishing | Never synced |

Asana notifies Relay through a webhook per project, verified with the secret Asana provides. **Asana delivers webhooks
at most once** (and deletes a webhook after 24 hours of failed deliveries), so Relay also re-reads linked tasks — each
at most every 15 minutes — to catch anything missed. Changes Relay itself made are recognised and ignored when they
come back.

## If something goes wrong

| Situation | Result |
|---|---|
| Task deleted in Asana | The link shows unavailable; the Relay record is kept |
| Access revoked | Installation shows **Reconnect**; links unavailable; nothing deleted in Relay |
| Answer lost while creating | Job shows **Not confirmed**; Relay finds the task by the marker it added, instead of creating it twice |

**Disconnect** stops syncing and deletes Relay's stored token. Remove Relay from Asana under **My settings → Apps**
to revoke it there too (menu path not verified).

## Automation

Automation rules can run `asana.create_task` with the same rules (one selected project or the automation default).
