---
title: I'm not getting notifications or emails
summary: Check your notification settings, quiet hours, digest and email delivery when notifications seem to be missing.
section: troubleshooting
audience: user
status: available
related: [notifications-and-preferences, collaboration-settings]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [no email, missing notification, alerts not working, digest]
---

1. **In app first:** open the bell or **All notifications**. In-app notifications don't depend on email.
2. **Your settings:** **Settings → Personal → Notifications** — is **Email** ticked for that type? Is it set to **Digest**
   (one email a day)?
3. **Quiet hours:** emails wait until quiet hours end (security alerts still arrive).
4. **Access:** you only get notifications about things you can still see. If you lost access to a brand, its
   notifications disappear.
5. **Spam folder:** look for emails from your Relay installation.
6. **Email not set up:** if your Relay installation has no email delivery configured, no emails are sent at all. Admins
   see this in **Admin console → Collaboration → Notification delivery** as *not configured*, and can retry failed emails there.

Relay emails never include post or comment text, only what happened and a link.
