---
title: Set up two-step verification
summary: Add an authenticator app or a passkey, then generate recovery codes, so you can do sensitive actions and keep your account safe.
section: account-security
audience: user
status: available
related: [recovery-codes-and-lost-factors, step-up-verification, workspace-security-policy, manage-sessions]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [2fa, mfa, two-factor, authenticator, totp, passkey, webauthn, security key]
---

Two-step verification (also called MFA or 2FA) means signing in with your password **and** something you have: an
authenticator app code or a passkey. Your factors are stored by the identity provider, not by Relay; Relay can only see
which ones you have.

## Do I need it?

By default your workspace requires it for **Owner, Admin, Publisher and Brand manager** roles. Until you set it up you can
read everything, but sensitive actions — scheduling, publishing, inviting people, changing roles, connecting accounts,
exports, billing changes, automation and integrations — are refused with *Two-step verification required*. Owners can
require it for everyone ([Workspace security policy](/help/account-security/workspace-security-policy)).

## Add an authenticator app

1. Open **Settings → Personal → Security and sessions** ([/security](/security)).
2. Under **Two-step verification**, next to **Authenticator app**, select **Set up**.
3. You're taken to the identity provider. Scan the QR code with an authenticator app (any TOTP app works), enter the
   six-digit code and give the device a name.
4. **Result:** you return to **Security**; the app is listed. Your other sessions are signed out for safety, and you get
   an email confirming the change.

![Security page showing Two-step verified, an authenticator app with Add another and Remove, Passkeys Add, Recovery codes Generate, and the Sessions list with This device and Sign out buttons](/help/img/account-security/security-page.png)

## Add a passkey

1. On **Security**, next to **Passkeys**, select **Add**.
2. Follow your browser's or device's prompt (fingerprint, face, PIN or security key).
3. **Result:** the passkey is listed. You can add several.

## Generate recovery codes

1. After you have an app or passkey, select **Generate** next to **Recovery codes**.
2. Save the codes somewhere safe and offline. Each code works once.
3. **Regenerate** replaces all codes; **Remove** deletes them. Both ask you to verify again first.

## Check your session

The **Security** header shows **Two-step verified** or **Password only** for the current session. If it says Password
only and you have a factor, select **Verify now**.

## Common errors

| Message | Fix |
|---|---|
| Sign-in methods unavailable — Couldn't reach the sign-in provider. | Try again later. |
| Set up an authenticator app or passkey first | Recovery codes need another factor first. |
| Not changed — Verification was cancelled. | You backed out at the identity provider; start again. |

## Limitations

- Workspace admins can't see your codes and can't remove or reset your factors; only the identity provider can.
- SMS codes aren't supported.
