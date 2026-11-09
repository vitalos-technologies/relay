---
title: Connect business apps
summary: How Relay connects to Asana, monday.com, HubSpot, Slack, Mailchimp, Google Business Profile and Google Cloud Translation — what each one does, the sync rules, states, history, and what disconnecting does.
section: business-apps
audience: user
roles: [owner, admin, brand_manager, care_agent]
status: needs-setup
related: [asana, monday-com, hubspot, slack, mailchimp, google-business-profile, cloud-translation]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [integrations, business apps, hub, asana, monday, hubspot, slack, mailchimp, google business profile, translation, sync]
---

Business apps live under **Connections → Business apps** ([/integrations](/integrations)). Each app has its own page
with its installations, resources, sync rules, settings and history.

![Business apps tab listing Asana, monday.com, Google Business Profile and Google Cloud Translation as Simulated, and HubSpot, Slack and Mailchimp as Needs app setup (demo workspace)](/help/img/business-apps/business-apps-hub.png)

> **Important:** Every business app is built and tested against simulated provider APIs and signed test webhooks.
> None has been connected to a live account yet, and each needs the workspace owner to register an app with the
> provider in **Setup** first. Until then its card shows **Needs app setup**. Simulated installations (development
> and demo only) are labelled *Simulated*.

## What each app does

| App | What Relay does with it | Guide |
|---|---|---|
| Asana | Create and link tasks from posts, campaigns, conversations, cases and listening alerts | [Asana](/help/business-apps/asana) |
| monday.com | Create and link items on boards you choose | [monday.com](/help/business-apps/monday-com) |
| HubSpot | Look up CRM contacts, link them to inbox customers, create one ticket per case, add approved notes | [HubSpot](/help/business-apps/hubspot) |
| Slack | Send alerts to channels and approve posts from Slack | [Slack](/help/business-apps/slack) |
| Mailchimp | Create an email campaign **draft** from an approved post (never sends) | [Mailchimp](/help/business-apps/mailchimp) |
| Google Business Profile | Local posts from scheduled posts, location metrics, reviews in the inbox | [Google Business Profile](/help/business-apps/google-business-profile) |
| Google Cloud Translation | Machine translation in the inbox and composer, originals kept | [Cloud Translation](/help/business-apps/cloud-translation) |

## Who can do what

| Action | Permission (roles) |
|---|---|
| See the hub, installations and history | `integrations.read` (Owner, Admin, Brand manager, Care agent) |
| Connect, choose resources, edit sync rules, pause, reconnect, disconnect, Slack routes | `integrations.manage` (Owner, Admin) — for a brand or the whole workspace |
| Create a task from a post or campaign | Can edit content on the brand + `integrations.read` |
| Create a task or ticket from a conversation, case or listening alert | Inbox, case or listening access on the brand + `integrations.read` |
| Google local posts, Mailchimp drafts | Can schedule content on the brand |

## Connect an app

1. **Connections → Business apps** ([/integrations](/integrations)) → choose the app.
2. Read **Before you connect** and **Permissions requested** — Relay asks for the smallest set the app allows.
3. Select **Connect**, choose the **Scope** (one brand or the whole workspace) and sign in to the app. A reconnect must
   use the **same** external account.
4. Open **Resources** and explicitly select what Relay may use (projects, boards, pipelines, channels, audiences,
   locations). Nothing is used until you select it.

## Sync rules (the same for every app)

- By default every field flows **Relay → app** only. Two-way sync applies only to fields someone maps two-way (task
  title, due date, status).
- Approval, publishing state, owner/assignee, consent and customer contact details are **never** two-way.
- Nothing in an external app can approve, schedule or publish anything in Relay.
- When Relay has unsynced edits and the app changed the same field, the mapping's rule decides: **Ask a person**
  (default), **Source of truth wins** or **Skip**. Relay never uses "last write wins".
- Each app page shows its exact sync contract (field · source of truth · direction · on delete · on revoke).

## States and history

| State | Meaning |
|---|---|
| **Connected** | Working |
| **Checking** | First check after connecting |
| **Needs attention** | Recent errors (see **History**) |
| **Reconnect** | The app refused Relay's access (expired or revoked). Relay deleted the credential and marked links **unavailable**; Relay records stay |
| **Paused** | Nothing runs until resumed |
| **Disconnected** | Removed |

**History** lists every write (Create task, Update item, Create ticket, Add note, Google post, Draft campaign) with
its state: Queued, Running, Retrying, Done, Failed, Cancelled or **Not confirmed**. *Not confirmed* means the app's
answer was lost; Relay reconciles it using a marker it adds to what it creates, and **never sends it again blindly**.
Failed jobs have **Retry** and unconfirmed ones **Check again** in History.

## Disconnect

**Disconnect** stops all syncing, deletes Relay's stored credentials and marks links unavailable; Relay's own records
(posts, cases, tasks list) stay, and nothing is deleted in the external app. **Slack** is the only app where Relay
also revokes its token at the provider; for the others, remove Relay in the app's own settings if you want to revoke
it there too.
