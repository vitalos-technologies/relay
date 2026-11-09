---
title: Invite clients as guests and share reviews
summary: Give an external client time-limited access to review and comment on exactly the posts you share, and nothing else.
section: teams-and-approvals
audience: user
roles: [owner, admin, brand_manager, editor, guest]
status: available
related: [invite-people, comments-internal-notes-and-client-comments, approval-policies-and-stages, approve-or-request-changes, collaboration-settings]
product_version: "2026-11"
reviewed: 2026-11-09
order: 44
keywords: [client, guest, external reviewer, share review, review link, client portal]
---

A **guest** is an external person (typically a client) with a Relay sign-in, an expiring **Guest** role on one or more
brands, and access only to reviews you explicitly share with them.

## What a guest can and can't see

| Guests can | Guests can't |
|---|---|
| See the reviews shared with them in the review portal ([/review](/review)) | Open the planner, library, analytics, inbox or settings |
| See exactly what will be sent to each channel (the submitted version and media) | See the working draft or other posts |
| Read and write **shared** comments (if the workspace allows client comments) | See internal notes, other reviewers' identities or account details |
| Approve or request changes, if the stage allows guests | Approve anything not shared with them |

There are no anonymous review links: every client signs in, so you always know who approved.

## 1. Invite the client as a guest

**Required:** `members.invite` (Owner, Admin).

1. **Team → Invitations → Invite** ([/team/invitations](/team/invitations)), **Type: Guest reviewer**.
2. Enter their email, choose **Access for** (7–90 days, capped by your workspace's maximum) and at least one **Brand**.
3. **Send**. They accept and sign in with that email.

The access period always ends; extend it by giving a new guest grant on their member page before it lapses.
Up to **5** review-only guests don't count as paid seats (more than five do).

## 2. Share a post's review with them

**Required:** `content.submit` on the brand (Editor, Brand manager, Admin, Owner).

1. Open the post → **Collaborate** → **Review**, or the review in **Approvals** → **Client review**.
2. Under **Client guest**, pick the guest (only active guests of this brand are listed) and share.
3. **Result:** the guest gets a notification "A post is ready for your review" and sees it in **For your review**.
   Remove access any time with **Stop sharing with …**.

## 3. What the client does

1. Opens [/review](/review) (**For your review**) and selects the post.
2. Reads **What will be sent** and **Progress** (whether it's waiting for others and the **Review by** date).
3. Comments under **Comments** — *Visible to the team and shared reviewers* — and replies.
4. Selects **Approve** (*Only this exact version. Any change needs a new review.*) or **Request changes** with a reason
   (*The team will see this.*). Approve appears only when a stage allows guests.

## Common problems

| Problem | Fix |
|---|---|
| The guest isn't in the **Client guest** list | They haven't accepted yet, their access has expired, or they're a guest of another brand. |
| "Invite this person as a guest of the brand first" | Give them a Guest role on this brand. |
| The guest can't approve | The current stage doesn't allow client guests, or it's the internal stage that comes first. |
| The guest can't comment | An admin turned off *Clients can comment on shared reviews*. |
| "This review isn't available" | The share was removed, access expired, or the review was replaced by a newer version. |
