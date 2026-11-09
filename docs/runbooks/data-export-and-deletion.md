# Data export and deletion requests

Audience: operators and the data protection owner. Repo only. Reviewed 2026-11-09 (product 2026-11).

**Affected resources:** workspace content, assets in storage, inbox customer data, member accounts, provider tokens,
audit trails.

> **Gap:** Relay has no self-service "delete my account", "delete this workspace" or "export my personal data" action,
> and no configurable retention for inbox message text (kept for the workspace lifetime unless deleted at the network).
> Requests beyond the features below need an engineering-supported procedure. Do not improvise deletes in SQL.

## What the product already provides

| Need | Feature | Who |
|---|---|---|
| Export a brand's content | `POST /api/brands/<id>/handover-export` (`zip` or `json`): content, revisions, delivery history, assets with 15-minute signed links | `exports.create` on the brand; 3 per hour; audited |
| Export analytics | Analytics exports (CSV, HTML, PDF) | `analytics.read` + `exports.create` |
| Export activity / audit | `POST /api/activity/export` (CSV) | `audit.read` + `exports.create` |
| Export publishing history | `GET /api/history/export.csv` | Members who can read the content |
| Delete posts or media | Trash (soft delete, restorable for 30 days, then purged by the worker hourly) | Editors and above on the brand |
| Remove provider tokens | Disconnect the account: stored credentials are deleted immediately | `connections.manage` + step-up |
| Meta user removed the app / asked for deletion | `POST /api/meta/deauthorize` and `POST /api/meta/data-deletion` (signed by Meta): tokens deleted, connections marked "Reconnect required", stored Meta user id removed; status URL + confirmation code returned | Automatic |
| Remove a member | Workspace admins remove or suspend; access ends immediately; history (posts, approvals, audit) is kept | `members.manage` |
| Stop a person signing in at all | Platform → Accounts → Suspend (ends sessions; memberships unchanged) | Platform operator |
| Remove Content Hub snapshots | Delete a source item (refused while a retention hold is set); snapshots of items that lost access expire after the retention period | Brand managers |
| Customer message deleted at the network | Relay erases that message and its earlier revisions on ingest | Automatic |

## Handling a request

1. **Verify the requester** out of band (workspace owner for workspace data; the person themselves for personal data).
   Record the request, the identity check and the deadline in the ticket.
2. **Classify**: export, correction, deletion, or restriction; personal data of a member, of an inbox customer, or a
   whole workspace.
3. **Export requests**: run the features above as (or with) a workspace owner. For a member's personal data, include
   their profile (name, email), memberships, authored content and audit entries naming them. **READ-ONLY** queries for
   the audit part:
   ```sql
   SELECT created_at, action, resource_type, resource_id FROM audit_events WHERE actor_user_id='<user id>' ORDER BY created_at;
   ```
4. **Deletion requests**:
   - Content and media: Trash, then wait for the 30-day purge (or ask engineering for an expedited purge).
   - Provider tokens: disconnect the accounts.
   - Inbox customer data: no product action exists. Escalate for an engineering-supported erasure that also covers
     `inbox_customers`, `inbox_contacts`, messages, attachments in storage and search indexes. **DESTRUCTIVE**.
   - A member account: suspend (platform) to stop access now; erasure of the `users` row and authored history needs an
     engineering-supported procedure because posts, approvals and audit entries reference the user (anonymisation, not
     row deletion, is the expected approach). **DESTRUCTIVE**.
   - A whole workspace: suspend it (platform), cancel its subscription, export what the owner wants, then an
     engineering-supported purge of database rows **and** storage objects under the workspace. **DESTRUCTIVE**,
     irreversible; needs two operators and a recent backup (note that backups keep data until they expire).
5. **Identity provider**: the person's account at the identity provider is separate. Delete or disable it there if
   requested (Keycloak admin console → Users).
6. **Confirm** to the requester what was exported or deleted, what is kept and why (for example audit records or
   billing records with a legal retention period), and when backups containing the data expire.

## Verification

- Exports open and contain the expected data; trashed items are gone after purge; disconnected accounts have no stored
  credentials (`SELECT count(*) FROM connections c JOIN credentials k ON k.id=c.credential_id WHERE c.id='<id>'` → 0
  after disconnect).

## Escalation

Every deletion beyond the product features, and any request with a legal deadline, goes to the data protection owner
and the engineering owner. Never delete audit trails to satisfy a request without the data protection owner's
decision.
