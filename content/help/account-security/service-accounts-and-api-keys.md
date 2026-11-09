---
title: Create service accounts and API keys
summary: Let another system create drafts in Relay with a service account and a revocable API key - and rotate or revoke keys safely.
section: account-security
audience: admin
roles: [owner, admin]
status: available
related: [step-up-verification, suspend-or-remove-a-member, audit-log]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [api key, token, service account, bot, integration, rotate key, revoke key]
---

A **service account** is a non-human member that calls Relay's API with an **API key**. It belongs to one brand and has
a named owner. It is never a billable seat.

## Before you start

- **Required permission:** `service_accounts.manage` (Owner, Admin) with two-step verification. Creating an account or a
  key needs a fresh verification.
- Developers: the API itself is described in the developer documentation.

## Create a service account

1. Open **Settings → Developer → API and service accounts** ([/settings/developer/service-accounts](/settings/developer/service-accounts)).
2. Select **New** (the dialog is titled **New service account**) and fill in:
   - **Name** (for example *Product feed*).
   - **Brand**: the one brand it can work on.
   - **Access**: **Create drafts** (default; nothing else), **Read**, or **Edit drafts**. *Service accounts never publish
     or manage the workspace.*
   - **Owner**: an active member responsible for it.
   - **Expires** (optional, at most one year).
3. Select **Create**.

## Create a key

1. On the account, select **New key**.
2. **Copy it now.** The full key is **shown once**; afterwards only its prefix is visible.
3. Use it as `Authorization: Bearer …` in the other system. Store it in that system's secret store, never in code or chat.

Up to **5** active keys per account.

## Rotate, revoke, disable

| Action | Effect |
|---|---|
| **Rotate** | Issues a new key and revokes the old one at once. Update the other system immediately. |
| **Revoke** | The key stops working on its next request. |
| **Disable** | Revokes all keys and access of the account. |

If a key may have leaked, **revoke** it right away; keys can't be edited.

## What happens when the owner changes

- Owner suspended → the account's keys are refused until the owner is reactivated.
- Owner removed → the account is disabled and its keys revoked, unless ownership was handed over during removal.

## Limitations

- One brand per service account; roles limited to Create drafts, Read or Edit drafts.
- The TipSignal inbound integration appears here with a **TipSignal** badge; manage it under
  **Settings → AI and automation → Inbound sources**.
