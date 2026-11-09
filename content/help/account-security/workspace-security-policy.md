---
title: Set the workspace security policy
summary: Owners decide which roles need two-step verification, how often people re-verify, how long invitations last and how long guests keep access.
section: account-security
audience: user
roles: [owner]
status: available
related: [set-up-two-step-verification, step-up-verification, invite-people, guests-and-client-reviews]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [security policy, require mfa, enforce 2fa, invitation expiry, guest expiry]
---

**Required permission:** `security.manage` — **Owners only** (admins see *Owners only*). Open
**Settings → People and access → Workspace security** ([/settings/people/security-policy](/settings/people/security-policy)).

## Settings

| Setting | Default | Range | Effect |
|---|---|---|---|
| Require two-step for everyone | Off | — | *Members without it keep reading but can't do sensitive actions.* |
| Require two-step for | Owner, Admin, Publisher, Brand manager | any roles | Used when "everyone" is off. |
| Re-verify after (minutes) | 5 | 1–60 | Window for actions that need a fresh verification. |
| Invitations expire after (hours) | 72 | 1–720 | Lifetime of new invitation links. |
| Guest access, default (days) | 30 | 1–365, ≤ maximum | Pre-selected period for guests. |
| Guest access, maximum (days) | 90 | 1–365 | Longest guest access anyone can give. |

## Change the policy

1. Change the values and select **Save** (**Reset** discards).
2. Making the policy **less strict** (fewer roles needing two-step, a longer re-verify window, longer invitations or
   guest access) asks you to verify again first.
3. **Result:** the change applies to every member's next request and is recorded in the audit log.

## Consequences

- Turning on "everyone" doesn't lock anyone out: people without a second factor can still sign in and read, and are
  prompted to set one up when they try something sensitive.
- Existing invitations keep the expiry they were created with; existing guests keep their end date.
