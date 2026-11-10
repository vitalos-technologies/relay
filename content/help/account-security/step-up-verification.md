---
title: Why Relay asks you to verify again
summary: Some sensitive actions need two-step verification in this session, and a few need a fresh sign-in within the last few minutes.
section: account-security
audience: user
status: available
related: [set-up-two-step-verification, workspace-security-policy, roles-and-permissions]
product_version: "2026-11"
reviewed: 2026-11-10
order: 22
keywords: [step-up, verify again, confirm it's you, mfa required, re-authenticate]
---

Relay uses two checks on top of your role:

Signing in itself never asks for your authenticator app (Relay staff excepted). Instead:

1. **Two-step verification in this session** — for sensitive actions when your workspace requires it for one of your
   roles (by default owners, admins, publishers and brand managers). Message: *Two-step verification required* / *Verify with your second factor to do this.*
2. **Fresh verification (step-up)** — a few high-risk actions also need you to have signed in with your second factor
   within the last **5 minutes** (owners can set 1–60 minutes). Message: *Confirm it's you to continue.*

## Sensitive actions (need two-step when required for your role)

Change workspace settings · transfer ownership · invite people · change members and teams · connect or manage social
accounts · change the security policy · manage service accounts · schedule · publish · create exports · manage business
apps · manage automation · change billing.

## Actions that also need a fresh verification

Ownership transfer and accepting it · inviting or granting roles that can publish or administer · adding someone to a
publishing team (admins) · changing your sign-in methods (removing a factor, regenerating recovery codes) · connecting,
reconnecting or disconnecting a social account · creating service accounts and API keys · making the security policy or
an approval policy less strict · approving a Relay support-access request.

## What to do

1. Select **Verify now** in the prompt (or on [Security](/security)).
2. Enter the 6-digit code from your authenticator app (or use a passkey or recovery code). No new email, no password.
3. **Result:** you return to where you were and can retry the action. Your session token is renewed.

No authenticator app yet? The first time you're asked, Relay walks you through setting one up (scan a QR code, type one
code) and that counts as your verification — you go straight back.
