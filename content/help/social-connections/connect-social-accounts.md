---
title: Connect a social account
summary: Add an Instagram, Facebook, Telegram, X, TikTok, YouTube, LinkedIn, Threads, Pinterest or Bluesky destination to a brand, choose exactly which pages or profiles Relay may post to, and manage it afterwards.
section: social-connections
audience: user
roles: [owner, admin]
status: not-live-verified
related: [connection-status-and-fixes, network-limits-at-a-glance, set-up-social-network-apps, instagram, facebook, telegram, x-twitter, tiktok, youtube, linkedin, threads, pinterest, bluesky]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [connect, connection, account, page, profile, channel, board, oauth, reconnect, disconnect, pause, destination]
---

A **connection** links one destination on a social network (a Facebook Page, an Instagram professional account, a
Telegram channel, a Pinterest board and so on) to one **brand** in Relay. Posts for that brand can then be scheduled
to it. Each connection belongs to exactly one brand; connect the same account to another brand separately if you need to.

> **Important:** Relay has been tested end to end against simulated networks and recorded API contracts. No
> connection to a live network account has been verified yet, and most networks only let other people's accounts
> connect after the network has approved Relay's app. Each network guide says what is still needed.

## Who can do this

| Action | Who |
|---|---|
| See connections and their health | Everyone with access to the brand (Owner, Admin, Brand manager, Editor, Approver, Publisher, Analyst, Viewer, Care agent) |
| Connect, reconnect, pause, resume, disconnect | Owner and Admin |
| Make a network available to connect (app registration in **Setup**) | Workspace owner — see [Set up the social network apps](/help/social-connections/set-up-social-network-apps) |

Reconnecting and disconnecting change stored credentials, so Relay asks you to confirm your identity again (a fresh
two-step verification) if your last one was not recent.

## Connect a network

1. Open **Connections** ([/accounts](/accounts)) and stay on the **Social accounts** tab.
2. Under the brand you want, select **Connect**. The network picker shows every network:
   - **Available to connect** — ready to use.
   - **2 connected · add more** — already connected at least once for this brand.
   - **Not set up** — the workspace owner has not added the app details for that network yet. Selecting it explains
     what is missing.
3. Choose the network:
   - **Facebook, Instagram, X, TikTok, YouTube, LinkedIn, Threads, Pinterest** — you are sent to the network's own
     sign-in and consent screen. Approve **every** permission listed; declining one usually means Relay cannot
     publish (see each network guide).
   - **Telegram** — paste a bot token and the channel (`@name` or its `-100…` ID). See [Telegram](/help/social-connections/telegram).
   - **Bluesky** — enter your handle and an app password. See [Bluesky](/help/social-connections/bluesky).
4. For the OAuth networks you come back to **Choose destinations**. Tick the pages, profiles, organizations or boards
   Relay may post to. Destinations you cannot post to are shown greyed out with the reason (for example, "no posting
   role on this Page"). Nothing is connected until you select **Add**.
5. The new connection appears as a card. It may show **Verifying** for a few seconds while Relay checks it.

![The "Connect a network" dialog listing ten networks; Telegram shows "1 connected · add more", Bluesky "Available to connect" and the others "Not set up" (synthetic demo workspace)](/help/img/social-connections/connect-a-network.png)

**Expected outcome:** the card shows **Connected** (or a more specific state such as **Limited access**), the formats it
can publish (for example *Image · Album · Reel*), and whether analytics are available.

> **Note:** The sign-in link from the network is valid for 10 minutes, and the **Choose destinations** page for
> 15 minutes. If either expires, start again from **Connections**. Only the person who started the connection can finish it.

## What a connection card tells you

![Connections page with simulated Instagram, Facebook, Telegram and X cards for a demo brand, each showing Connected, the formats it publishes and its analytics availability](/help/img/social-connections/connections.png)

| Item | Meaning |
|---|---|
| State badge | One honest label: Connected, Missing permission, Awaiting platform approval, Unsupported for this account, Reconnect required, Manual handoff, Limited access, Expires soon, Paused, Verifying, Disconnected. See [Connection states and fixes](/help/social-connections/connection-status-and-fixes). |
| **Publishes** | The post formats this destination accepts in Relay (Text, Image, Album, Video, Reel). |
| **Analytics** | Whether Relay reads post statistics for this destination: **Available** or **Not available**. See below. |
| **Expires** | When the network's sign-in expires (reconnect before then). |
| **Rate limited until** | The network asked Relay to slow down; publishing to this destination resumes after this time. |

**Analytics** is **Available** when Relay reads post statistics for the account:

- **Facebook** and **Instagram:** when the account allowed Meta's insights permission (`read_insights` /
  `instagram_manage_insights`). Relay records what was allowed when you connect and at every connection check; without
  it the card shows **Not available** — reconnect and allow insights once the workspace requests them.
- **X:** always (public metrics). Each read is billed by X and counts against the workspace's X reads cap.
- **TikTok, YouTube, LinkedIn:** when the analytics permission was granted. **Threads, Pinterest, Bluesky:** always.
- **Telegram:** never — Telegram provides no post statistics.

The same answer appears in [Connection health](/help/social-connections/connection-status-and-fixes) and to AI tools
through MCP. Use the **Analytics** pages to see what was actually collected.

## Manage a connection

Open the **⋯** menu on the card:

| Action | What happens |
|---|---|
| **Check now** | Relay asks the network whether the sign-in and permissions still work and updates the state. Relay also checks connections in the background. |
| **Diagnostics** | (When the *Integration diagnostics* feature is on.) Shows recent checks and requests for troubleshooting. |
| **Pause** | Posts to this destination will not send. Posts whose deadline passes while paused **expire**. Other destinations are unaffected. |
| **Resume** | Posts still before their deadline send again. |
| **Reconnect** | Repeats the sign-in. Use it to grant missing permissions, renew an expired sign-in, or replace a Telegram bot token or Bluesky app password. Reconnecting with a *different* account adds a new connection instead of replacing this one. |
| **Disconnect** | See below. |

## Disconnect: what happens

1. Select **⋯ → Disconnect…** and confirm.
2. Relay immediately:
   - deletes the stored sign-in for this destination;
   - marks every scheduled delivery to it **Blocked** (they will not send; reschedule them to another destination);
   - keeps everything already published **on the network** — disconnecting never deletes posts there;
   - stops collecting analytics. Statistics already collected stay visible, labelled "access ended", for 90 days and
     are then deleted.
3. For **X**, Relay also asks X to revoke its access token. For every other network, Relay cannot remove itself from
   your account's list of connected apps: do that in the network's own settings if you want to revoke access there
   too (each guide says where).

**Cancelling a schedule vs. disconnecting vs. deleting a post:** cancelling a schedule only stops future sends of that
post; disconnecting blocks all future sends to that destination; neither removes anything already published. Relay
cannot edit or delete a published post on any network — open it on the network to do that.

## If someone revokes access on the network side

If a person removes Relay from their Facebook, Google, X or other account settings, or loses their role on the
page, the next check or publish fails and the card turns **Reconnect required** or **Missing permission**. Scheduled
posts to it wait and are blocked rather than silently dropped. Reconnect with an account that still has access.

## Common errors when connecting

| Message | What to do |
|---|---|
| Cancelled. Nothing was connected. | You declined on the network's screen. Start again and approve. |
| Link expired. Start again. | More than 10 minutes passed, or the link was reused. Start again from Connections. |
| Started by another user. Start again. | The connection must be finished by the person who started it, in the same browser session. |
| No pages or profiles to publish to. | The account you signed in with manages no eligible destination (for example no Facebook Page with a posting role, no Instagram professional account, no Pinterest board). |
| Network not set up. See Setup. | The workspace owner must add the network's app details. |
| Network error. Try again shortly. / Couldn't list pages. | The network did not answer; try again in a few minutes. |
| No permission for this brand. | Only Owners and Admins of the brand can connect. |

## Limitations

- Relay never edits or deletes posts after publication, on any network.
- One connection publishes to one destination; to post to several Pages or boards, connect each one.
- Your plan may limit how many accounts you can connect. Relay tells you when a new connection would exceed it.
- **Simulated destinations** (only in development and demo environments) are labelled *Simulated*: nothing is sent to
  a network.
