---
title: Lost your phone or passkey - use a recovery code
summary: Sign in with a one-time recovery code, replace your lost factor, and what to do if you have no codes left.
section: account-security
audience: public
status: available
related: [set-up-two-step-verification, manage-sessions, cant-sign-in]
product_version: "2026-11"
reviewed: 2026-11-10
order: 21
keywords: [lost phone, recovery code, backup code, locked out, reset 2fa, new phone]
---

## Verify with a recovery code

Your normal sign-in (email or Google) never needs the authenticator app; you need a recovery code only when Relay asks
for two-step verification (sensitive actions, or every sign-in for Relay staff).

1. On the two-step screen, select **Try another way** and choose **recovery code**.
2. Enter one of your saved codes. Each code works only once.
3. **Result:** you're verified. For safety Relay **signs out all your other sessions** and emails your verified address.

## Replace the lost factor

1. Go to **Security** ([/security](/security)).
2. **Remove** the lost authenticator app or passkey (you'll verify again first).
3. **Set up** a new authenticator app or **Add** a new passkey.
4. **Regenerate** recovery codes, because you've used one.

## No codes and no factor

Relay has no master key or bypass. Your Relay installation's identity-provider administrator must verify who you are
(for example by a call with another workspace owner) and reset your second factor. Then sign in, set up a new factor and
generate new codes. Ask your workspace owner to arrange this. If you are the only owner, contact Relay support (the
support chat on Relay's website when it is enabled, or ask a colleague to open a request from **Help → Contact support**).

## Limitations

- Workspace owners and admins can't reset your two-step verification inside Relay.
