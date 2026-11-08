# Relay support — visibility and permissions matrix (V4)

Server-enforced in `packages/services/src/support/access.ts` (customer side) and `requireSupportStaff` (staff side). Hidden
navigation only mirrors these rules. Cross-tenant or not-permitted lookups return **404** (no existence leakage).

## Who sees a ticket

| Viewer | Normal ticket | Restricted ticket (category "Security or private account matter") |
|---|---|---|
| Requester (still an active member of the ticket's workspace) | ✔ read, reply, resolve, reopen, export transcript | ✔ |
| Participant (an active member explicitly added by the requester or a `support.workspace` holder) | ✔ same as requester | ✔ |
| Workspace owner / admin (`support.workspace`, preset) | ✔ read, reply, resolve, reopen, add people | ✘ |
| Other workspace members | ✘ | ✘ |
| Members of another workspace | ✘ (404) | ✘ (404) |
| Relay operator with approved **support access** (temporary `viewer` grant) | ✘ through the customer API (viewer has no `support.workspace`) | ✘ |
| Relay staff, role `support` | ✔ all tickets, internal notes, attachments, workspace context | ✔ |
| Relay staff, role `operator` | ✔ (⊇ support) | ✔ |
| Relay staff, role `billing` | ✘ — every support endpoint refuses (no ticket content, no notes) | ✘ |

Workspace and requester identity always come from the session; the payload never names a workspace or user.

## What each side can see

| Data | Customer APIs / UI | Staff (support, operator) |
|---|---|---|
| Subject, customer messages, staff **public** replies | ✔ | ✔ |
| Staff names | First name + "· Relay" on replies only | Full names |
| **Internal notes** (`support_notes`) | ✘ never — not in detail, list, change feed, transcript export, search, notifications or emails | ✔ (dashed amber frame, lock) |
| Staff-only history (assignment, priority, category, duplicate links, notes) | ✘ | ✔ |
| Customer-visible history (created, resolved + reason, reopened, archived, people added, support access steps) | ✔ (no staff names) | ✔ |
| Attachments on messages | ✔ (authorized download, re-checked per request) | ✔ |
| Attachments on internal notes | ✘ (404) | ✔ |
| Safe diagnostics the customer chose to include | ✔ | ✔ |
| Workspace context (plan/status, connection health counts, recent failure counts/codes, open reports, support access) | — | ✔ metadata only — never posts, media, credentials, tokens or social messages |

## Separation from the social inbox (V3.5)

Own tables (`support_*`), own authorization (above), own notification kinds (`support.*`, preference "Relay support
replies"), own change feed (`support_activity`), own search document (`support_tickets.search_doc`, public text only), own
retention (below), own AI path (staff-only, not the workspace assistant budget). Nothing is sent through a customer's
social accounts, and tickets never appear in `/inbox`.

## Permissions used

- Any active member: create and read **their own** requests (no permission needed — support is always available, also while
  billing restricts paid actions).
- `support.workspace` (owner/admin presets): workspace-wide non-restricted requests; add participants (with `members.read`).
- `members.manage` + step-up: approve/decline/end support access (existing V3.1 flow).
- Staff: `platform_operators.role` in (`support`, `operator`), re-read on every request.

## Retention

| Record | Kept | Deleted |
|---|---|---|
| Tickets, messages, notes, participants, read state | While the workspace exists | With the workspace (cascade), or 730 days after archive (worker purge, objects first) |
| Resolved tickets | — | Auto-archived after 30 days (still readable) |
| Attachments (private bucket `support/<id>`) | With their ticket | Never-attached uploads after 1 hour; rejected files immediately; purged with the ticket |
| Ticket history (`support_activity`) | Append-only for app roles | Cascades with the ticket (runs as table owner) |
| AI drafts | 30 days | Worker sweep |
| Notifications | Existing notification retention | — |
| Platform/workspace audit entries | Append-only (V3.1) | Not deleted by support purges (metadata only, no message text) |

Retention values are configuration constants in `packages/core/src/contracts/v4-support.ts`. This describes behaviour; it
is not a certification of legal compliance.
