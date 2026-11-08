# Platform → Support — staff guide (V4)

For Relay staff with platform role **support** or **operator** (`pnpm platform:operator <email> support`). Billing staff
cannot open tickets. Admin → Platform → **Support**.

## Inbox
Queues: **New and unassigned**, **Assigned to me**, **Waiting for Relay** (new + customer replied), **Waiting for
customer**, **Resolved**, **Archived**, **All open**. Search covers reference, subject, public messages, requester email and
workspace name (internal notes are not searchable). Filter by category and priority. Urgent/high sort first. The page
refreshes from a content-free change feed. The bell shows your support notifications (new requests, customer replies,
assignments, reopened requests, access decisions).

## A ticket
- **Assignee / Priority / Category** at the top. Your first public reply assigns an unassigned ticket to you.
- Composer modes, visually distinct:
  - **Reply to customer** — normal frame, "Sent to …"; notifies the requester and participants. Optional **Resolve after sending**.
  - **Internal note** — dashed amber frame with a lock, "Staff only — never shown to the customer". Never notified, exported,
    indexed or shown to customers.
- **Saved replies** inserts staff-approved text (manage under Support → Saved replies). Attach files to replies or notes.
- Under each public reply: who was notified and the email outcome (emailed / not configured / failed / skipped). A failed
  email never fails the reply.
- **Actions**: Resolve (with a reason), Archive (resolved only), Reopen, Mark waiting on Relay/customer, **Mark as duplicate**
  (links to the original and resolves; the customer sees "Resolved · duplicate"), **Request support access**.
- Side panel: customer + workspace metadata (state, members, plan/status/access from billing, connection health, 7-day
  delivery failures and codes, participants), diagnostics the customer chose to share, support access, **Assist**, related
  problem reports, duplicates and other open tickets from the workspace. No posts, media, credentials or social messages.

## Assist (drafts only)
**Summarize** and **Draft reply** use the configured AI provider (otherwise "AI is not set up"). Ticket text is treated as
data; the model has no tools and cannot change anything. Drafts never include internal notes; summaries may. A draft that
claims something was fixed, refunded or changed is flagged — check the relevant service before saying so. **Suggest
category** (keywords) and **Related** (similar tickets by public text + saved replies) work without AI. Staff AI use is not
charged to the customer's AI budget; it is rate-limited per staff member and recorded in the platform audit.

## Support access from a ticket
See `SUPPORT_ACCESS_WORKFLOW.md`. Ticket participation never grants workspace access.

## Audit
Assignment, ticket updates, duplicates, saved-reply changes, AI use and support-access steps are in the platform audit;
support-access steps and problem-report shares are also in the workspace audit.

## Limits
Customers: 10 new requests/hour, 30 replies/10 min, 20 uploads/10 min per person. Staff: 120 replies/10 min, 30 AI runs/hour.
