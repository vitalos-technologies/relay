# Workspace administration guide

For owners and admins (team managers see People within their team). All actions use the same services as the main app.

## People and access
- **Grants** are role + scope (workspace, brand or one connection). You can only grant what you hold; only owners grant
  admin; nobody grants owner (use ownership transfer). Guests must expire.
- **Effective access** (member page) is computed by the same policy that enforces requests, with the source of each
  permission (direct or via a team) and any deny rule.
- **Suspend** stops the person on their next request; posts they scheduled are re-checked at send time and held if
  their authority is gone. **Adopt** held posts from People → Held publications or the delivery drawer.
- **Remove** shows the impact first and can reassign work. The last owner can't be removed or demoted.

## Publishing operations
- Deliveries shows every destination with: Awaiting approval, Scheduled, Queued, Processing, Provider-scheduled,
  Published, Failed, Unknown, Cancelled, Expired, Paused, Held, Retrying, Manual handoff.
- **Retry** is offered only for failed/expired/held items whose schedule is current and connection healthy. Published
  destinations are never resent. **Unknown** means it may already be live: check the channel and *Resolve*, or retry
  only after accepting duplicate risk.
- **Cancel** stops every destination that hasn't started; sending/provider-held destinations can't be recalled — the
  result says how many. Provider-scheduled releases record *cancel requested* vs *cancelled* separately.
- **Reschedule** runs the normal checks (approval, brand rules, readiness) and fails if someone else changed it first.
- **Dead-lettered events** can be requeued only when the consumer is idempotent (never emails or external writes).

## Connections and content
- Customer account authorization (per connection) is separate from Relay's provider apps (platform). "Configured" never
  means "fully operational". Diagnostics are read-only and never post.
- Jobs and storage lists imports, exports, writebacks, reports, bulk changes and media processing with safe errors;
  recover in the owning screen (Content hub, Trash, Analytics) so linked-document and snapshot rules hold.

## Security
- Audit log is append-only for the application's database roles. Support access needs your approval, is read-only,
  time-boxed, banner-visible and can be ended any time.
- Workspace security policy controls MFA requirements and the step-up window.

## Usage
Caps (AI tokens, storage, exports, X reads/writes) are enforced by atomic reservations in the app, workers and MCP. They
apply to the next reservation and are never retroactive. There is no billing system.
