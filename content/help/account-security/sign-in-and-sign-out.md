---
title: Sign in and sign out
summary: How signing in to Relay works, how long a session lasts, and what the sign-in error messages mean.
section: account-security
audience: public
status: available
related: [set-up-two-step-verification, manage-sessions, accept-an-invitation, cant-sign-in]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [login, log in, log out, sign on, sso, session expired, password]
---

Relay doesn't keep passwords itself. **Sign in** sends you to your Relay installation's identity provider, which checks
your password (and second factor, when you have one) and sends you back.

## Sign in

1. Go to the sign-in page and select **Sign in**.
2. Enter your email and password at the identity provider; complete two-step verification if asked.
3. **Result:** you land on **Overview** (or on the page you were trying to open). If you belong to several workspaces,
   you return to the one you used last.

New to Relay? **Start a free trial** on the sign-in page creates a sign-in and a new workspace (where self-service sign-up
is enabled). To join an existing workspace you need an [invitation](/help/teams-and-approvals/accept-an-invitation).

## How long you stay signed in

- A session ends after **30 minutes without activity** or **12 hours** after you signed in, whichever comes first.
  There is no silent extension: sign in again.
- Some actions ask you to **verify again** even within a session (see [Verify it's you](/help/account-security/step-up-verification)).

## Sign out

Open the account menu (your avatar) → **Sign out**. To sign out other devices, use
[Manage your sessions](/help/account-security/manage-sessions).

## Sign-in messages

| Message | What it means | What to do |
|---|---|---|
| Sign-in cancelled. | You cancelled at the identity provider. | Try again. |
| Link expired. Start again. | The sign-in attempt took too long or started in another tab. | Start again from the sign-in page. |
| No workspace yet. Ask an admin to invite you. | Your sign-in works but you belong to no workspace. | Ask for an invitation, or start a trial. |
| Use the invited email address. | You opened an invitation but signed in with another address. | Sign out and use the invited address. |
| Invitation expired. Ask for a new one. | The invitation link is too old. | Ask the admin to resend. |
| Session ended. Sign in again. | Idle or absolute time limit reached, or the session was signed out. | Sign in again. |
| Session changed. Sign in again. / You verified as a different account. | A different person or account was used during verification. | Sign in again as yourself. |
| Verification was not fresh. Try again. | A step-up check didn't include a fresh sign-in. | Repeat the verification. |
| Identity provider error. Try again. / Sign-in cancelled or refused. | The identity provider refused or failed. | Try again; contact your admin if it persists. |

More: [I can't sign in](/help/troubleshooting/cant-sign-in).
