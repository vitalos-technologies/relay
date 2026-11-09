---
title: Receive drafts from TipSignal
summary: Bind the TipSignal inbound source to one brand so its signed events create drafts - never published automatically.
section: administration
audience: admin
roles: [owner]
status: needs-setup
related: [service-accounts-and-api-keys, create-a-post]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [tipsignal, inbound, webhook, automatic drafts, integration]
---

**Required:** Owner (*Owner only*). Open **Settings → AI and automation → Inbound sources**
([/settings/automation/inbound](/settings/automation/inbound)).

**TipSignal** — *Signed events create drafts in one brand. Nothing is published automatically.*

1. Check the **Signing secret** is set for your Relay installation (*Not set* → an Owner completes **Setup** first).
2. Choose the **Brand** and bind it. **Result:** *TipSignal bound*; a **Service account** named TipSignal is created with
   draft-only access to that brand.
3. Drafts from TipSignal appear in **Create → Drafts** for review, editing and scheduling like any other draft.

**Unbind** → *Unbind TipSignal?* — *New events will be refused. Existing drafts stay.*

TipSignal can be bound to one workspace per Relay installation (*Bound to another workspace on this installation.*).
Brand rules can require that TipSignal facts are kept unchanged before publishing.
