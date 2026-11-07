# Queued task: Relay V4 — commercial and customer-support layer

Received from the user 2026-11-07 ("next, queue this, call it V4"). Runs after V3.5 (it reuses V3.5 conversation
components and must preserve V3.5 requirements), before copy cleanup and Documentation + Help Centre.
Supersedes the earlier "support inbox" proposal (HANDOFF queue item 6b). Brief below is verbatim.

---

Implement the missing commercial and customer-support layer in Relay.
The Platform admin is Relay staff's dashboard for managing all customer tenants. Workspace administration remains the customer's own area for managing their team and settings.
Add:

1. Customer-to-Relay support conversations.
2. Platform support operations.
3. Plans, trials, subscriptions, billing, and invoices.
4. Customer billing self-service.
5. Connected tenant lifecycle and entitlement management.

Inspect the repository and verify the reported baseline before implementing. Preserve existing functionality, tenant isolation, support-access controls, publishing safeguards, and V3.5 requirements.
Proceed autonomously through implementation and testing. Put missing credentials, commercial settings, and external activation steps in one final checklist.

## 1. Verify the baseline
Check whether the current implementation contains:

* `/admin` Platform and Workspace modes.
* Workspace-local problem reports.
* Platform workspace management.
* Time-limited, owner-approved support access.
* Subscription or payment-provider code.
* Notifications and email delivery.
* Shared conversation components from V3.5.

Do not assume the supplied description matches the code exactly.
Document gaps and reuse existing services where appropriate.

## 2. Make administration scopes explicit
Platform administration
For authorized Relay staff:

* All customer workspaces.
* Customer support conversations.
* Plans and subscriptions.
* Billing status and provider references.
* Usage and entitlements.
* Trials and lifecycle state.
* Operational health.
* Support-access requests.
* Platform audit history.

Workspace administration
For authorized customer owners and administrators:

* Their workspace settings.
* Team and roles.
* Connections and publishing.
* Their support conversations.
* Their plan, usage, and billing where permitted.

Platform support access must not automatically grant billing powers. Billing access must not automatically expose private customer content.
Use server-enforced permissions, not just hidden navigation.
Keep settings and subsections in the left sidebar.

## 3. Add customer-to-Relay support
Add Help → Contact support and Help → My requests.
Customers can:

* Create a support request.
* Choose a category.
* Enter a subject and message.
* Attach permitted screenshots or files.
* See ticket status and replies.
* Reply, resolve, or reopen according to policy.
* View requests they are authorized to access.

Suggested categories:

* Account access.
* Billing.
* Publishing.
* Connections.
* Analytics.
* Technical problem.
* Feature request.

Generate a stable, customer-visible ticket reference.
Keep the form short. Do not require technical details ordinary users cannot provide.

Request visibility
Default requests to the requester and explicitly permitted participants.
Allow authorized workspace owners to access workspace support requests under a clearly documented policy. Provide a restricted category for sensitive security or account matters.
Do not expose every employee's support conversation to every workspace member.
Store the requesting workspace and user identity from trusted server context.

## 4. Build Platform → Support
Provide a genuine staff support inbox with:

* New and unassigned.
* Assigned to me.
* Waiting for Relay.
* Waiting for customer.
* Resolved.
* Archived.

Support:

* Staff assignment and reassignment.
* Priority and category.
* Search and filters.
* Customer and workspace context.
* Public replies.
* Staff-only internal notes.
* Attachments.
* Saved replies.
* Related problem reports.
* Related billing and operational records.
* Ticket history.
* Duplicate linking.
* Resolution reason.
* Reopening.

Make Reply to customer and Internal note visually distinct.
Internal notes must never appear in customer APIs, notifications, exports, search results, or realtime payloads.
Show useful workspace metadata such as plan, connection health, and recent relevant failures without automatically exposing posts, media, credentials, or private social messages.

## 5. Separate Relay support from the social inbox
The V3.5 social inbox handles a customer's conversations with their audience.
This new support inbox handles the customer's conversation with Relay staff.
Reuse safe UI and messaging infrastructure, but keep distinct:

* Authorization.
* Conversation types.
* Participants.
* Routing.
* Notifications.
* Retention.
* Search indexes or access filters.
* AI retrieval permissions.

Do not route Relay support messages through customers' social accounts.
Do not make a Relay support ticket visible in the customer's public-facing social inbox.

## 6. Connect existing problem reports
Preserve workspace-local problem reports.
Add an explicit Send to Relay support action that:

* Shows what information will be shared.
* Creates or links a support ticket.
* Includes selected diagnostics.
* Records who submitted it.
* Keeps the original report reference.

Do not automatically export historical reports or private workspace data.
Allow the user to review attachments and diagnostics before submitting.
Capture safe technical context such as:

* App version.
* Route without sensitive query parameters.
* Timestamp.
* Browser family.
* Correlation ID.
* Relevant error code.

Never attach tokens, cookies, full browser storage, private draft content, or raw logs by default.

## 7. Support messaging and notifications
Implement durable messages and notification delivery.
Customers receive:

* An in-app notification when staff reply.
* An email notification if email is configured and preferences permit.
* A secure link to the conversation.

Staff receive appropriate assignment and new-reply notifications.
Requirements:

* Deduplicate sends.
* Handle retries.
* Recheck recipient permissions before delivery.
* Keep email previews minimally sensitive.
* Preserve read/unread state.
* Update both interfaces after persisted changes.
* Show failed notification delivery separately from ticket-message success.

Start with email notifications linking back to Relay.
Do not claim email replies are supported unless an authenticated inbound-email pipeline with threading, attachment processing, and abuse controls is actually implemented.

## 8. Link support-access requests to tickets
Reuse the existing owner-approved, time-limited support-access mechanism.
From a ticket, authorized staff can request access with:

* Reason.
* Requested scope.
* Requested duration.
* Relevant ticket reference.

The workspace owner can approve or reject through the existing trusted flow.
Show active access clearly to both sides.
Enforce expiry and immediate revocation server-side, including active sessions and subscriptions.
Keep access read-only unless a separately defined and explicitly authorized workflow permits more.
Ticket participation does not grant workspace access.
Do not automatically attach private workspace content to the conversation after access is granted.
Record access requests, grants, usage, expiry, and revocation in the audit history.

## 9. Add plans and billing
Inspect existing billing code first.
Reuse an established provider integration if suitable. If none exists, use Stripe Billing and hosted checkout/customer-portal flows as the default implementation choice, after checking current official documentation.
Use test mode during development.
Do not activate live charges, buy services, or create real subscriptions without existing authorization.
Implement configurable:

* Plans.
* Monthly and annual billing options.
* Trial policy.
* Seat allowances.
* Connected-account allowances.
* Storage limits.
* Publishing allowances.
* AI and listening entitlements.
* Usage thresholds.
* Grace-period policy.

Do not invent final commercial prices. Use clearly marked test prices and keep public purchasing unavailable until live products and prices are configured.
Version plan definitions and map them to provider price identifiers. Existing subscriptions must not silently change because someone edits a plan label.
Keep provider-specific billing logic behind a shared billing service.

## 10. Subscription lifecycle
Implement and distinguish:

* Trialing.
* Active.
* Payment action required.
* Past due.
* Cancellation scheduled.
* Cancelled.
* Expired.
* Other provider states where relevant.

Treat billing status, workspace suspension, and product access as related but separate state dimensions.
Define and document transitions for:

* Starting a trial.
* Successful checkout.
* Trial expiry.
* Renewal.
* Failed payment.
* Payment recovery.
* Upgrade.
* Downgrade.
* Cancellation.
* Reactivation.

Use verified provider events and reconciliation as authoritative billing evidence.
A checkout success URL is not proof of payment.
Handle out-of-order and duplicate webhooks, signature verification, retries, and missed-event reconciliation.
Prevent duplicate subscriptions from repeated checkout clicks.

## 11. Customer billing self-service
Add Workspace Settings → Billing for permitted users.
Show:

* Current plan.
* Subscription status.
* Trial or renewal date.
* Billing interval.
* Usage and limits.
* Cancellation status.
* Payment-method summary from the provider.
* Invoice links.
* Available plan changes.

Provide authorized flows to:

* Start a subscription.
* Upgrade.
* Schedule a downgrade.
* Update payment details.
* View invoices.
* Cancel renewal.
* Reactivate when supported.

Use provider-hosted payment collection. Do not store card numbers or security codes.
Before plan changes, show applicable pricing, timing, and proration information from the provider.
Make cancellation and downgrade effects explicit.
Preserve access to billing and support when payment issues restrict other product functions.

## 12. Entitlements and usage
Create one shared entitlement service used by:

* Main app.
* Admin app.
* APIs.
* Workers.
* MCP.
* AI actions.
* Integrations.

Enforce limits server-side.
Track usage through durable, deduplicated events with a defined billing period and reset policy.
Avoid races when concurrent actions consume the last available unit.
Distinguish:

* Included allowance.
* Current usage.
* Reserved usage.
* Hard limits.
* Warning thresholds.
* Optional overages, only if explicitly configured.

Do not enable surprise overage charges.
Administrative overrides require a reason, scope, audit record, and optional expiry.
A customer-supplied plan name or frontend flag must never grant paid capabilities.

## 13. Downgrades, failed payments, and existing work
Define behavior for customers exceeding a new limit.
Do not delete data or arbitrarily disconnect accounts.
Allow an authorized customer to choose which resources remain active where necessary.
Apply a documented grace and restriction policy.
Explicitly define what happens to:

* Scheduled posts.
* Queued replies.
* Existing approvals.
* Active automations.
* AI jobs.
* Listening ingestion.
* Storage uploads.
* Exports.
* Support conversations.

Recheck entitlements at action and dispatch time as appropriate.
Show held or blocked work with a clear reason. Do not silently drop jobs.
Preserve existing rules for in-flight and uncertain provider operations; billing changes must not introduce duplicate publication.
Cancellation ends service according to the configured effective date. It must not silently delete the workspace.

## 14. Platform tenant and billing administration
Extend Platform → Workspaces with:

* Plan and subscription status.
* Trial dates.
* Renewal and cancellation dates.
* Provider customer/subscription references.
* Usage summary.
* Entitlement overrides.
* Payment issues.
* Open support requests.
* Lifecycle history.

Provide permitted actions to:

* Inspect billing state.
* Open the provider's authorized billing record.
* Apply documented entitlement overrides.
* Extend an eligible trial.
* Suspend and reactivate a workspace.
* Schedule appropriate lifecycle changes.

Distinguish service suspension from cancelling billing. Do not imply one automatically performs the other.
Sensitive actions require appropriate authorization, an action summary, and audit logging.
Implement refunds only if explicitly included in the established billing scope; otherwise link staff to the provider workflow rather than adding an unverified refund button.

## 15. Operational security
Protect customer and staff routes independently.
Implement:

* Least-privilege support and billing roles.
* Strong authentication for privileged staff.
* Secure webhook validation.
* Rate limits for support creation and attachments.
* Private attachment storage.
* File-type and size validation.
* Malware scanning or quarantine through the established upload pipeline.
* Tenant-safe search.
* Short-lived authorized attachment access.
* Secret redaction.
* Audited administrative actions.

Do not add hidden superadmin bypasses.
Define retention and deletion behavior for support messages, attachments, billing references, and audit records. Preserve records required by the configured retention policy without claiming legal compliance has been independently certified.

## 16. AI support assistance
If Relay AI is available, allow staff to:

* Summarize a ticket.
* Draft a reply.
* Find approved help articles.
* Suggest a category.
* Identify related known issues.

Keep AI responses as drafts by default.
Do not let ticket text trigger privileged tools, change subscriptions, issue refunds, or grant support access.
Use only authorized ticket content and approved knowledge sources.
AI must not claim an issue is fixed, a refund issued, or an account changed without evidence from the relevant service.

## 17. Design and mobile
Use Relay's established design system and concise copy.
Do not add explanatory paragraphs to every screen.
Keep support easy to find from desktop and mobile.
Verify at 320, 360, 390, 430, 768, and 1440 CSS-pixel widths.
Essential mobile workflows:

* Create a support ticket.
* Attach a screenshot.
* Read and reply.
* Approve or revoke support access.
* Inspect a plan and usage.
* Open hosted checkout.
* Update payment details.
* Cancel renewal.
* Staff triage and reply.
* Staff inspect a tenant's billing status.

Ensure usable keyboards, scrolling, focus, touch targets, and safe areas.
Keep payment-provider requests, email delivery, and AI generation out of initial page rendering. Read stored summaries and refresh asynchronously.

## 18. Verification
Test:

1. A customer request appears in Platform → Support.
2. Staff replies appear in the correct customer account.
3. Another tenant cannot read the ticket or attachments.
4. Internal staff notes never reach customers.
5. Duplicate message submissions do not duplicate notifications.
6. A problem report is shared only through the explicit submission flow.
7. Support access requires the existing owner approval and expires correctly.
8. A trial becomes active after verified test checkout.
9. A forged checkout redirect does not activate a plan.
10. Duplicate or out-of-order billing webhooks produce consistent state.
11. Failed payment and recovery apply the documented policy.
12. Upgrade, downgrade, cancellation, and reactivation work correctly.
13. Entitlements are enforced through UI, API, workers, and MCP.
14. Concurrent usage cannot bypass limits.
15. Customers can reach billing and support while restricted.
16. Existing publishing reliability is preserved.
17. Essential mobile workflows pass.

Use the provider's test environment. Clearly separate test-mode verification from live activation.

## 19. Documentation and final delivery
Create or update:

* Support user guide.
* Platform support guide.
* Support visibility and permissions matrix.
* Support-access workflow.
* Plans and entitlement definitions.
* Billing lifecycle and webhook design.
* Failed-payment and downgrade policy.
* Tenant lifecycle runbook.
* Mobile QA report.
* Test results.
* Remaining implementation gaps.
* Final activation checklist.

The activation checklist should contain only genuinely remaining items, such as:

* Live provider credentials.
* Verified webhook endpoint.
* Final prices and plan allowances.
* Trial and grace-period decisions.
* Email sender configuration.
* Support staff assignments.
* Required billing and customer-policy text.

Do not leave working features as placeholders merely because live credentials are missing.
Finish with a concise report distinguishing implemented functionality, test-mode verification, live verification, and external activation requirements.
Begin with repository inspection and complete the implementation, integration, tests, and documentation.
