---
title: Sign in and sign out
summary: Sign in with Google or with a link and code sent to your email. No passwords. What the sign-in messages mean.
section: account-security
audience: public
status: available
related: [set-up-two-step-verification, step-up-verification, manage-sessions, accept-an-invitation, cant-sign-in]
product_version: "2026-11"
reviewed: 2026-11-10
order: 10
keywords: [login, log in, log out, sign on, magic link, email code, google, passwordless, session expired, password]
---

Relay has **no passwords**. You sign in with **Google** or with **your email**: Relay sends you one email with a sign-in
button and a 6-digit code.

## Sign in with your email

1. Select **Log in** (or open any Relay page).
2. Enter your email and select **Continue with email**.
3. Open the email from Relay. Either:
   - select **Sign in to Relay** in the email, in the same browser where you asked for it, or
   - type the **6-digit code** on the *Check your email* page — handy when the email opens on your phone.
4. **Result:** you land on **Overview** (or the page you were opening). With several workspaces, you return to the last one.

The link and code expire after **15 minutes** and work **once**. Need another? Select **Send a new code**. Typed the wrong
address? Select **Use a different email**.

## Sign in with Google

Select **Continue with Google** (shown when your Relay installation has Google sign-in switched on). Google signs you in
to your existing Relay account only when Google has **verified** the same email address.

## New to Relay

From the pricing page, choose a plan → **Continue**. The same page appears as **Create your Relay account**: use Google or
your email. A new account is created only where self-service sign-up is on; otherwise ask for an
[invitation](/help/teams-and-approvals/accept-an-invitation).

## Two-step verification

Ordinary sign-in doesn't ask for it. Relay asks for your authenticator app when you do something sensitive — billing,
removing people, connecting accounts and similar — and Relay staff confirm it every time they sign in. See
[Verify it's you](/help/account-security/step-up-verification).

## How long you stay signed in

- A session ends after **30 minutes without activity** or **12 hours** after you signed in, whichever comes first.
- Some actions ask you to **verify again** within a session (see [Verify it's you](/help/account-security/step-up-verification)).

## Sign out

Open the account menu (your avatar) → **Sign out**. One click: Relay also ends your sign-in at the sign-in server and you
land on the Relay home page. To sign out other devices, use [Manage your sessions](/help/account-security/manage-sessions).

## Sign-in messages

| Message | What it means | What to do |
|---|---|---|
| That code isn't right. | The code doesn't match the latest email. | Use the newest email's code. |
| Too many tries. Send a new code. | Five wrong codes. | Select **Send a new code**. |
| This code has expired. Send a new code. | More than 15 minutes passed. | Select **Send a new code**. |
| This link has expired or was already used. | Sign-in links work once. | Start again; a new email arrives. |
| That sign-in expired, or it was finished in a different browser. | The link was opened in another browser than the one you started in. | Type the 6-digit code in the first browser instead. |
| There's no Relay account for this Google email. | Google sign-in can't create accounts here. | Ask for an invitation, or use the invited email. |
| Use the invited email address. | You opened an invitation but signed in with another address. | Sign out and use the invited address. |
| Session ended. Sign in again. | Idle or absolute time limit reached, or you were signed out. | Sign in again. |
| You verified as a different account. | Someone else's authenticator was used during verification. | Sign in again as yourself. |

No email? Check spam, wait a minute, then [I can't sign in](/help/troubleshooting/cant-sign-in).
