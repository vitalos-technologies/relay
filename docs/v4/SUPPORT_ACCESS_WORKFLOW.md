# Support access from a ticket (V4)

Reuses the V3.1 owner-approved, time-limited, read-only mechanism (`packages/services/src/admin/support-access.ts`); V4 adds
the ticket link, owner notification, customer-visible ticket history and a worker expiry sweep.

1. **Request** (staff, ticket → Actions → Request support access): reason (10+ characters), duration (30 min – 24 h), scope
   fixed to **read-only, whole workspace** (the only scope that exists). The grant row stores `support_ticket_id` and the
   ticket reference. One open request/grant per staff member per workspace. Requests lapse after 24 h.
2. **Owner notification**: outbox `support.access_requested` → every owner/admin who can decide gets an in-app notification
   (and email per preferences) linking to Admin → Security and audit → Support access. The ticket shows "Relay support asked
   for read-only access" to customers who can see it; owners/admins can approve or decline from the ticket too.
3. **Decision** (owner/admin, `members.manage` + fresh MFA sign-in): approve → an ordinary expiring `viewer` grant (plus a
   membership if needed); decline → nothing granted. The requesting staff member is notified (`support.access_decided`).
4. **Active**: shown on the ticket (both sides), in the staff context card and in the existing workspace banner. Access is
   read-only; nothing is attached to the ticket automatically. A viewer grant never includes `support.workspace`, so the
   operator still cannot read the workspace's support requests through the customer API.
5. **End**: either side can end it at any time; the worker sweep (`support-sweeps`, every 60 s) ends expired grants and
   lapses unanswered requests. Ending revokes the grant, removes a membership created for it and bumps the policy version,
   so open sessions and live streams lose access on their next check; expiry is also enforced by the policy on every request.
6. **Audit**: requested / approved / declined / ended / cancelled in both the platform audit and the workspace audit, plus a
   line on the ticket.
