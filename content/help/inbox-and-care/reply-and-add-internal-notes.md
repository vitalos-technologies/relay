---
title: Reply to customers and add internal notes
summary: Answer publicly or privately, keep team-only notes, and understand sending results, reply windows and "not confirmed" messages.
section: inbox-and-care
audience: user
roles: [owner, admin, brand_manager, care_agent]
status: not-live-verified
related: [work-in-the-inbox, saved-replies-and-views, cases-and-service-levels, when-paid-actions-are-paused]
product_version: "2026-11"
reviewed: 2026-11-09
order: 20
keywords: [reply, respond, private message, dm, public reply, internal note, reply window, not sent]
---

## Choose the mode

Under the conversation, pick the mode before typing:

| Mode | Who sees it | Sent to the network? |
|---|---|---|
| **Public reply** | Everyone who can see the comment on the network. | Yes |
| **Private message** | The customer only (for example a Messenger message, or one private reply to a comment). | Yes |
| **Internal note** | Your team in Relay only. | **Never** |

Switching mode keeps your text and never sends anything. Notes are stored separately from replies and are never sent,
even by mistake. Not every channel supports every mode; unavailable modes are hidden.

## Send

1. Type the reply (or insert a saved reply).
2. Watch the **reply window** hint, for example *Reply window closes in 5h*. On WhatsApp a charged reply also shows
   **This reply is charged** (see [WhatsApp in the inbox](/help/inbox-and-care/whatsapp-in-the-inbox)).
   After a network's window closes, private replies are refused by the network.
3. Select send.

If something changed since you started typing — *Someone else replied* or *New messages arrived* — Relay stops and shows
it. Read it, then select **Reviewed** and send, or **Send anyway**. Only one reply can be sending per conversation.

## Sending results

| Shown on your message | Meaning | What to do |
|---|---|---|
| Sending… | Queued or being sent. | Wait. |
| Sent | The network accepted it. (Delivered/Read appear only when the network reports them.) | — |
| Not sent | The network refused it; the reason is shown (*The network refused this action.*). | **Edit and resend**. |
| Not confirmed | The answer from the network was lost. Relay tries to look it up. | If it can't, check the network and choose **It was sent** or **Not sent**. Nothing is resent automatically. |
| Outside Relay | A reply someone sent directly on the network. | — |

## Permissions and holds

- You need `inbox.reply` on the brand. With read-only access you see *You can read but not reply here.*
- While paid actions are paused (billing), replies are held, not sent, and go out when access returns if the network's
  reply window still allows it.
