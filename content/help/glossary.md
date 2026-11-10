---
title: Glossary
summary: Short definitions of the words Relay uses for workspaces, posts, deliveries, approvals, roles, analytics and billing.
section: getting-started
audience: public
status: available
related: [what-is-relay, find-your-way-around, roles-and-permissions]
product_version: "2026-11"
reviewed: 2026-11-10
order: 10
keywords: [terms, definitions, vocabulary, meaning, words, dictionary]
---

Terms are grouped by topic. Labels in **bold** are the words you see in the app.

## Workspaces and accounts

| Term | Meaning |
|---|---|
| **Workspace** | Your organisation's account in Relay. People, brands, billing and settings belong to it. You can belong to more than one workspace and switch between them. |
| **Brand** | A group inside a workspace for one client, product or business line. It has its own channels, time zone, rules and (optionally) approval policy. |
| **Channel** | One connected social account (for example an Instagram professional account or a Facebook Page) that posts are sent to. |
| **Connection** | The authorisation that lets Relay act on a social account, business app or content source. Shown under **Connections**. |
| **Business app** | A connected work tool such as Asana, monday.com, HubSpot, Slack or Mailchimp. |
| **Content source** | Google Drive, Google Docs or Notion, used to import content into Relay. |
| **Demo workspace** | A workspace with sample data for trying Relay out, marked with a flask icon in the workspace switcher. |

## Posts and content

| Term | Meaning |
|---|---|
| **Post** | One piece of content going to one or more channels. |
| **Draft** | A post that hasn't been scheduled or published yet. |
| **Shared copy** | The text and media all channels of a post start from. |
| **Channel version** | A channel's own text or media, when it needs to differ from the shared copy (for example a shorter text for X). |
| **Content library** | Where drafts, media, templates and imported content are kept. |
| **Template** | A reusable starting point for new posts. |
| **Campaign** | A named group of posts you plan and report on together. |
| **Alt text** | A description of an image for people who use screen readers. |
| **Validation warning** | A message that a channel's text or media breaks a rule (for example it's too long), shown before you publish. |
| **Destination** | One channel a post goes to, with its own channel version, time and delivery. |
| **Revision** | A frozen copy of a post. Approvals and deliveries are tied to the exact revision that was reviewed. |
| **Brand rules** | A brand's checks on content (for example required wording or banned phrases). **Mandatory** rules block sending; **advisory** rules only warn. |

## Scheduling and delivery

| Term | Meaning |
|---|---|
| **Publish now** | Send a post straight away. |
| **Schedule** | Send a post at a chosen date and time. |
| **Time zone** | The zone a scheduled time is in. Brands have a default; Relay handles daylight saving changes. |
| **Posting slots** | Regular times a brand posts at, used to fill a queue. |
| **Content queue** | Posts lined up for a brand's posting slots, including evergreen posts that can be reused. |
| **Deadline** | How long after its scheduled time a post may still be sent. After that it expires instead of going out late. |
| **Held** | A scheduled post Relay stopped because the person who authorised it lost the right to publish or approve. Nothing is sent until someone **adopts** it. |
| **Adopt** | Take over a held post as the new authoriser so it can be sent. Holds are never released automatically. |
| **Simulated destination** | A demo or test channel. Relay records a result but nothing reaches a real network. |
| **Delivery** | One post going to one channel. A post sent to three channels has three deliveries. |
| **Published** | The network confirmed the post is live. |
| **Partial success** | Some channels of a post were published and others weren't. Only the others need attention. |
| **Failed** | The network refused the post. The reason is shown with it. |
| **Retrying soon** | A temporary problem; Relay will try again automatically. |
| **Unknown — needs review** | Relay can't tell whether the network published the post (shown as **Not confirmed** on Overview). Check the live account before trying again. |
| **Manual handoff** | The network doesn't allow Relay to publish this kind of post, so someone has to post it by hand. |
| **Blocked** | Something must be fixed before sending, such as a missing permission or a rule. |
| **Expired** | The post wasn't sent before its deadline, so Relay didn't send it late. |
| **Paused** | Publishing is held for a workspace, brand or channel until someone resumes it. |
| **Cancelled** | The schedule was cancelled before sending. Cancelling doesn't delete anything already published. |

## Reviews and approvals

| Term | Meaning |
|---|---|
| **Approval policy** | A brand's rule for which posts need approval and by whom. |
| **Stage** | One step of an approval policy. Posts can need several stages in order. |
| **Awaiting approval** | Submitted for review and not yet decided. |
| **Changes requested** | A reviewer sent the post back for edits. |
| **Quorum** | How many different people must approve a stage. |
| **Separation of duties** | A policy option: authors and editors can't approve their own work. |
| **Review share** | A link that lets a guest review one post. |
| **Approval reset** | Editing an approved post cancels the approval; it has to be approved again. |
| **Internal note** | A comment only your team can see. |
| **Client comment** | A comment shared with guests reviewing the post. |
| **Guest** | Someone outside your team who can only see what's shared with them, such as a client reviewing posts. |

## People and security

| Term | Meaning |
|---|---|
| **Role** | A fixed set of permissions, such as **Owner**, **Admin**, **Brand manager**, **Editor**, **Approver**, **Publisher**, **Analyst**, **Viewer**, **Exporter** or **Care agent**. |
| **Permission** | One thing a role allows, such as publishing or managing members. |
| **Scope** | Where a role applies: the whole workspace, one brand or one connection. |
| **Effective access** | Everything a person can do once all their roles, teams and restrictions are combined. |
| **Restriction** | An explicit "deny" on a person that overrides what their roles allow. |
| **Team** | A group of members who share roles. Team managers can manage their team's members. |
| **Owner** | The person with full control of a workspace, including security policy and ownership transfer. Every workspace has one. |
| **Two-step verification** | A second check at sign-in, such as a code from an authenticator app. |
| **Step-up verification** | Being asked to verify again before a sensitive action. |
| **Recovery code** | A one-time code that signs you in if you lose your second factor. |
| **Support access** | Time-limited, read-only access an owner or admin grants to Relay support staff. Everything they open is recorded. |
| **Session** | One signed-in browser or device. You can sign out other sessions. |
| **Service account** | A non-human member used by an integration, with an API key instead of a password. |
| **API key** | A secret that lets a service account or tool call Relay. It's shown once when created. |
| **MCP** | Model Context Protocol: a standard way for AI tools to use Relay's features on your behalf, within your permissions. |
| **Audit log** | A record of important changes: who did what, when and to what. |

## Inbox, listening and AI

| Term | Meaning |
|---|---|
| **Inbox** | Comments and messages from connected accounts, in one place. |
| **Conversation** | A thread with one person or about one post in the Inbox. |
| **Case** | A piece of customer work tracked across conversations until it's resolved. |
| **Service level (SLA)** | A target time for first response or resolution. |
| **Saved reply** | Reusable reply text for the Inbox. |
| **Listening search** | A saved set of words and sources Relay watches for mentions. |
| **Unique mentions** | Mentions with repeats collapsed: identical text within 7 days counts once. |
| **Share of voice** | One search's mentions divided by the total across the searches you compare, over the same sources and period. |
| **Coverage** | Which sources and dates a listening chart is based on, shown with every chart. |
| **Approved knowledge** | Documents an admin allows the AI to rely on for a brand. |
| **Listening** | Following mentions and topics on connected sources. |
| **Assistant** | Relay's AI helper for drafting, planning and analysing. Anything it would publish, schedule or send is only prepared; a person confirms it first. |
| **AI workflow** | A guided AI task with set steps, such as **Campaign from a brief** or **Weekly planning**. |
| **Automation** | A rule that does something when an event happens, within limits set by an admin. |
| **Automation policy** | Limits an admin sets on what automation rules may do. |
| **Emergency stop** | Switches all automation rules off at once. |

## Analytics

| Term | Meaning |
|---|---|
| **Impressions** | How many times content was shown. One person can see it several times. |
| **Reach** | How many accounts saw content, as reported by each network. Reach from different networks can't be added up to count unique people. |
| **Engagement** | Interactions such as reactions, comments, shares and saves, as each network defines them. |
| **Lifetime metric** | A running total since the post was published, not activity in the selected period. |
| **Stale data** | Numbers that haven't been refreshed from the network recently. |

## Billing

| Term | Meaning |
|---|---|
| **Plan** | **Free** (£0, one user), or **Standard** or **Professional**, priced per user per month. |
| **Trial** | 14 days free on Standard or Professional, without a card. Ends on Free if you don't subscribe. |
| **Seat** | One paid member. Guests don't use a seat. |
| **Billable user** | A member who counts as a paid seat. |
| **Allowance** | The monthly amount of a metered feature included in your plan. |
| **Budget** | A safety cap you set yourself on a metered feature. |
| **Restricted** | The workspace state when a payment problem outlasts the grace period: paid actions such as publishing are paused until billing is sorted out. |
| **Support request** | A message to Relay support, followed in **Help → My requests**. |
