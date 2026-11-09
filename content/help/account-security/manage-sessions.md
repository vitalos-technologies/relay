---
title: See and sign out your sessions
summary: Check where you're signed in, sign out one device or every other device, and review recent sign-in activity.
section: account-security
audience: user
status: available
related: [sign-in-and-sign-out, set-up-two-step-verification, recovery-codes-and-lost-factors]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [sessions, devices, sign out everywhere, logged in devices, revoke session]
---

1. Open **Settings → Personal → Security and sessions** ([/security](/security)).
2. **Sessions** lists every live session: browser and device, when it started, when it was last seen, and whether it was
   two-step verified (**Two-step**). Your current one is marked **This device**.
3. To end one session, select **Sign out** on its row and confirm.
4. To end all others, select **Sign out others** and confirm.

**Result:** the signed-out sessions stop working on their next request.

## Recent activity

**Recent activity** shows sign-ins, verifications, sign-in method changes and sign-outs, for example *Recovery code used
· other sessions signed out* or *Signed out by identity provider*.

## Automatic sign-outs

- After 30 minutes idle or 12 hours in total.
- When you sign in with a recovery code or change a sign-in method, Relay signs out your other sessions.
- When you sign out at the identity provider, Relay signs out the matching sessions.

## Limitations

- You can only see and end your own sessions. Admins remove someone's access to a workspace by suspending or removing
  them (their sessions stay valid for other workspaces).
