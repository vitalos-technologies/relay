---
title: Set up approval policies and stages
summary: Decide per brand whether posts need review, with up to two stages, quorum, eligible roles or teams, client guests and separation of duties.
section: teams-and-approvals
audience: user
roles: [owner, admin, brand_manager]
status: available
related: [submit-a-post-for-review, approve-or-request-changes, when-an-approval-is-reset, guests-and-client-reviews, plans-and-features]
product_version: "2026-11"
reviewed: 2026-11-09
order: 42
keywords: [approval workflow, review stages, quorum, separation of duties, two-step approval, compliance]
---

## Before you start

- **Required permission:** `brands.manage` on the brand to change its policy (Brand manager, Admin, Owner). Anyone can
  read it.
- **Plan:** one review stage is part of every plan. A **second stage** needs Professional (multi-step approvals). If you
  move to Standard, an existing two-stage policy stays in force, but you can't add a second stage.
- Making a policy weaker (fewer approvals, wider eligibility, guests allowed, separation of duties off, removing a stage)
  asks you to confirm it's you (step-up).

## Build a policy

1. Go to **Settings → Publishing → Approval policies** ([/settings/publishing/approvals](/settings/publishing/approvals))
   and choose the brand.
2. With no stages the card says *No review — posts can be scheduled directly.* Select **Add stage**.
3. For each stage (up to **2**, reviewed in order):
   - **Name** (1–60 characters), for example *Internal review* or *Client review*.
   - **Quorum**: how many **different** people must approve (1–10).
   - **Eligible roles**: Owner, Admin and/or Approver. *None selected = anyone who can approve on this brand.*
   - **Eligible teams**: *None selected = any team.*
   - **Client guests can approve**: only guests the review was shared with.
4. **Separation of duties**: *Authors and editors can't approve their own work.*
5. Select **Save policy** (or **Confirm & save** when it weakens review).

![Approval policies settings for the brand Lumen Lane Bakery showing "No review — posts can be scheduled directly", an Add stage button and the Separation of duties switch](/help/img/teams-and-approvals/approval-policy.png)

## What changes when you save

- Saving creates a new version of the policy. **Open reviews restart** under the new policy: pending requests are
  invalidated and authors resubmit.
- Posts that were **already approved** under the old version are re-checked before sending and are **held** until
  reviewed again. A policy change never publishes anything early and never releases held posts.
- Once a brand has at least one stage, **nobody** can schedule or publish it directly; everyone uses Submit for review.

## Example (synthetic)

*Northwind Coffee* uses two stages: **Internal review** (quorum 1, Approver role, separation of duties on) and
**Client review** (quorum 1, client guests allowed). An editor submits; an internal approver approves stage 1; the
client guest, to whom the post was shared, approves stage 2; the post goes out at its scheduled time.

## Check who can approve

Admins can see who is currently eligible for each stage in the admin console: **Collaboration → Collaboration settings →
Eligible reviewers** (choose a brand). "Nobody is eligible yet" means no one can complete the stage — fix roles or teams.

## Limitations

- At most two stages; stages are sequential, not parallel.
- One person can approve only one stage of the same request.
- Eligible roles are limited to Owner, Admin and Approver (plus guests when allowed); Brand managers and Publishers can't
  approve.
