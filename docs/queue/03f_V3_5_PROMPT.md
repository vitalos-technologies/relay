# Relay V3.5 — Integration hub, unified inbox, listening, AI assistant (queued)

Queue position: after Team collaboration completion (03d), before Copy cleanup (03e) and Documentation + Help Centre (04), so copy and docs cover V3.5 too. Brief saved verbatim from the user (2026-11-07).

---

You are the lead engineer implementing Relay V3.5 in the existing repository.
Extend Relay with:

1. An integration hub.
2. A unified social inbox and customer-care workspace.
3. Social listening and actionable insights.
4. A context-aware social AI assistant.
5. Complete integration with the main app, admin app, collaboration, notifications, and MCP.

Preserve all existing V1–V3.1 requirements, collaboration additions, admin integration, responsive design, performance budgets, and concise UI copy.
This version supersedes earlier exclusions of a customer inbox and social listening.

## 1. Execution and completion rules
Inspect repository instructions, specifications, database migrations, application services, tests, and the running app before changing code.
Verify what has actually been built. Do not assume prior prompts were implemented.
Proceed autonomously with routine implementation decisions. Record missing credentials, provider reviews, licences, and external dependencies in one final activation checklist. Continue independent work while those dependencies remain unavailable.
Do not invent successful connections, listening results, messages, AI outputs, or delivery receipts.
Keep synthetic fixtures isolated from live environments.
Use official supported APIs and authorized data sources. Verify current documentation for each implemented capability and record the verification date.
Do not buy subscriptions, enable new paid services, or send real customer messages during development without existing authorization.
Finish working vertical workflows, not just screens or connector logos.

## 2. Product structure
Add these primary areas:
* Inbox.
* Listening.
* AI Assistant.
* Integrations.

Keep existing Planner, Composer, Analytics, Content, Collaboration, and Admin functionality.
Use these boundaries:
* Publishing manages outgoing social posts.
* Inbox manages customer conversations, comments, and reviews.
* Collaboration manages internal teamwork.
* Analytics measures connected-account performance.
* Listening analyzes conversations available from explicitly identified sources.
* AI assists across authorized modules.

Reuse shared identities, permissions, brands, assets, audit services, and background infrastructure.
Do not merge customer-facing replies and internal comments into an ambiguous editor.

## 3. Integration hub
Implement connectors for:
* Asana.
* HubSpot.
* Google Business Profile.
* monday.com.
* Google Cloud Translation.
* Slack.
* Mailchimp.

Preserve Google Drive, Google Docs, Notion, and existing social integrations.
Each connector must provide:
* Connect, configure, diagnose, reconnect, and disconnect.
* Workspace and brand scope.
* Explicit resource selection.
* Granted capabilities and missing permissions.
* Mapping configuration.
* Last successful sync.
* Error and retry history.
* Rate-limit and quota information where observable.
* Pause and resume.
* Audit history.
* Clear setup prerequisites.

Use appropriate OAuth flows for multi-customer integrations. Keep credentials encrypted server-side and apply least-privilege scopes.
Do not automatically import all resources available to the connected account.

### Synchronization contract
For each mapped field define:
* Source of truth.
* Sync direction.
* External identifier.
* Conflict behavior.
* Deletion behavior.
* Access-revocation behavior.

Default to deliberate one-way flows. Enable two-way synchronization only for explicitly mapped fields.
Implement durable event processing, deduplication, checkpoints, retries, backoff, origin markers, and reconciliation.
Prevent update loops and duplicate external records.
Do not use last-write-wins indiscriminately for ownership, approvals, consent, or customer-sensitive fields.

## 4. Asana and monday.com
Allow authorized users to:
* Create an external task from a post, campaign, conversation, or case.
* Select the destination project or board.
* Map title, description, owner, deadline, priority, and supported status fields.
* Link an existing task.
* View external status in Relay.
* Open the original record.
* Synchronize configured updates.

Show a preview of information leaving Relay.
Do not copy entire private conversations into external tasks by default. Prefer a safe summary and authorized link.
An external task becoming "Done" must not approve or publish social content.
If external access disappears, preserve the Relay record and mark the external link unavailable.

## 5. HubSpot
Add CRM context and customer-care handover.
Support, subject to verified API access:
* Search and link contacts.
* Display permitted contact and company context.
* Create or link support tickets.
* Map ticket pipeline, stage, owner, and priority.
* Synchronize selected ticket fields.
* Add an approved conversation summary.
* Navigate between Relay and HubSpot records.

Do not merge identities based only on matching names or social handles.
Require reliable identifiers or an explicit authorized linking action. Make incorrect links reversible and auditable.
Linking a customer to a CRM record does not establish marketing consent.
Respect field visibility and minimize copied personal information.

## 6. Google Business Profile
Support selected, authorized business locations.
Implement verified capabilities for:
* Reading and creating supported local posts.
* Receiving or synchronizing reviews.
* Drafting and publishing owner replies.
* Displaying available performance metrics.
* Linking reviews to customer-care cases.

Keep location identifiers and permissions explicit.
Do not implement the discontinued Business Profile chat feature.
Distinguish deleting an owner reply from deleting a customer's review. Offer only actions the provider actually permits.
Prevent accidental mass updates across locations.
Route post creation through existing scheduling and approval services. Route review replies through the customer-care reply service.

## 7. Google Cloud Translation
Use the supported Cloud Translation API, not automation of the consumer website.
Add translation to:
* Incoming inbox messages.
* Reply drafts.
* Social post variants.
* Selected listening results.

Preserve original text.
Show source and target languages, and identify machine-translated content.
Support brand glossaries where available. Preserve links, mentions, placeholders, and product names appropriately.
A translation must not automatically replace approved content or send a customer reply.
Let users review the exact outgoing translation before sending.
Track usage, quotas, failures, and cost estimates where available. Do not claim translation is free or always accurate.
Apply workspace controls for sending customer content to translation providers.

## 8. Slack
Support:
* Approval requests.
* Assignment notifications.
* Connection and delivery alerts.
* Customer-care escalations.
* Listening alerts.
* Scheduled summaries where configured.

Allow explicit destination-channel selection and notification preferences.
Interactive actions must verify the Slack request and map the actor to a current authorized Relay identity.
Do not trust a matching display name or an unsigned button payload.
Bind approval actions to the exact revision. Expired or changed content must require a fresh review.
Use minimal notification content with secure Relay links. Do not expose private messages in broadly accessible Slack channels.
Provide deduplication, rate controls, quiet hours, and delivery history.

## 9. Mailchimp
Support:
* Selecting authorized audiences and campaigns.
* Creating campaign drafts from approved Relay content.
* Linking social and email campaigns.
* Reading supported campaign results.
* Viewing draft/export status and external links.

Keep email audience selection and campaign content review explicit.
Never subscribe social commenters, inbox contacts, or imported CRM contacts automatically.
Preserve unsubscribe and suppression states. Retain consent provenance where contacts are intentionally synchronized.
Campaign sending is a separate privileged action. Do not make "Export to Mailchimp" silently send an email campaign.
Initially prioritize draft creation and reporting. If sending is implemented, apply audience, content, permission, and approval checks immediately before dispatch.

## 10. Unified social inbox
Build a real inbox for supported:
* Direct messages.
* Post comments and replies.
* Mentions.
* Business reviews.
* Customer-care interactions.

Audit each existing social adapter separately for inbound and outbound capabilities.
Publishing access does not imply messaging access.
Include Instagram, Facebook, Telegram, X, TikTok, YouTube, LinkedIn, Threads, Pinterest, Bluesky, and Google Business Profile in the capability assessment.
Add WhatsApp Business Platform as a customer-care connector, subject to verified account access, permissions, templates, messaging policies, and charges.
Do not promise that every network supports DMs, comments, historical import, or replies.
For Telegram, support conversations actually accessible to the authorized bot. Do not imply access to subscribers' private chats or overwrite an existing webhook without an explicit ownership/migration plan.
For each channel record:
* Supported conversation types.
* Read and reply permissions.
* Public versus private visibility.
* Webhook or polling support.
* Historical availability.
* Reply-window restrictions.
* Attachment constraints.
* Moderation capabilities.
* Delivery and read-receipt availability.
* Required approval or commercial access.

Show unsupported capabilities honestly.

## 11. Inbox experience
Desktop:
* Left: queues and filters.
* Centre: conversations.
* Right: selected conversation and customer context.

Mobile:
* Navigate between queue, thread, and customer detail.
* Preserve position and unsent drafts.
* Keep the reply composer usable with the keyboard open.

Support:
* Unassigned, mine, team, waiting, snoozed, resolved, and spam queues.
* Search and saved views.
* Channel, brand, assignee, priority, language, and label filters.
* Assignment and reassignment.
* Internal notes and @mentions.
* Saved replies.
* Attachments where supported.
* Thread history and related posts.
* Snooze and reopening.
* Presence and reply-collision warnings.

Make "Public reply," "Private message," and "Internal note" unmistakable.
Changing reply mode must preserve the draft without sending it.
At send time, recheck permissions, channel restrictions, conversation state, and the latest thread version. Warn or block when another agent has already replied.

## 12. Customer-care cases and service levels
Allow conversations to be linked to cases.
Support:
* Case owner and team.
* Priority and category.
* Open, waiting, resolved, and reopened states.
* Business hours and timezone.
* First-response and resolution targets.
* Escalation rules.
* Resolution reason.
* CRM ticket links.
* Customer history within authorized scope.

Define service-level calculations explicitly:
* What starts the clock.
* Which states pause it.
* Whether automated acknowledgements count.
* How business hours and holidays apply.
* How reopened cases are measured.

Report first response, resolution time, backlog, breaches, and reopened cases with clear definitions.
Add optional customer satisfaction requests only through supported, explicitly enabled channels. Report response count and response rate alongside scores.
Do not infer satisfaction from silence.

## 13. Message reliability
Inbound processing must:
* Validate provider webhook authenticity using its supported mechanism.
* Persist durably before acknowledging acceptance.
* Deduplicate events.
* Handle edits, deletions, ordering, and missed-event reconciliation.
* Safely process attachments.
* Respect retention requirements.

Outbound replies must:
* Use durable delivery jobs.
* Record the exact message revision.
* Revalidate provider reply rules at dispatch.
* Use idempotency where available.
* Distinguish pending, sent, failed, and unknown outcomes.
* Reconcile uncertain sends rather than blindly retrying.
* Show delivered/read only when supported by provider evidence.

A local queue acknowledgement is not proof that the customer received a message.

## 14. Social listening
Build listening in two clearly identified layers.

### Connected-source monitoring
Analyze authorized comments, mentions, reviews, and other accessible interactions from connected accounts.
Keep private customer messages in a separate permission scope. Exclude them from public share-of-voice and competitor reports.

### Broader listening
Use approved APIs or licensed providers for wider public mentions, news, blogs, forums, competitor references, and other available sources.
Implement a provider interface and coverage registry.
Do not scrape logged-in pages, bypass access controls, or imply universal social-network coverage.
If broad data access is unavailable, deliver functioning connected-source monitoring and clearly mark broader listening as awaiting provider activation.
Do not claim Lumen-equivalent coverage without evidence.

## 15. Listening features and honest metrics
Implement:
* Saved searches.
* Brand names, aliases, keywords, exclusions, and supported Boolean expressions.
* Language and source filters.
* Mention timelines.
* Topic grouping.
* Sentiment with uncertainty and manual correction.
* Volume-spike alerts.
* Competitor comparisons using comparable sources.
* Share of voice within the observed dataset.
* Saved dashboards.
* Source-linked summaries and reports.
* Create task, case, or content draft from an insight.

Display:
* Data source.
* Retrieval timestamp.
* Available history.
* Coverage limitations.
* Sampling or provider limitations.
* Query version.
* Relevant denominators.

Distinguish zero matches from incomplete collection or source failure.
Deduplicate syndicated or repeated material where practical and explain the method.
Do not describe inferred sentiment as fact, infer sensitive personal traits, or invent audience demographics.
Trend alerts need minimum sample sizes, baseline logic, deduplication, and cooldowns.
Deleting or correcting source records must propagate into search indexes and derived reports as required by the applicable retention policy.

## 16. Relay AI assistant
Build a contextual assistant available from:
* Composer.
* Inbox.
* Listening.
* Analytics.
* Planner.
* Content Hub.

Support:
* Drafting and adapting social copy.
* Summarizing a conversation.
* Suggesting replies.
* Translating drafts.
* Suggesting labels, routing, and priority.
* Explaining observed analytics.
* Summarizing listening results with evidence.
* Creating campaign briefs.
* Turning an insight into a draft or task.
* Answering questions using authorized brand knowledge.

Use approved brand assets and selected document sources from the existing Content Hub.
Preserve source permissions in retrieval. Do not place all customer documents into an unscoped shared knowledge store.
Answers about policy, prices, stock, refunds, or commitments must use current approved sources or acknowledge uncertainty.
Show relevant source links and freshness. Distinguish evidence from suggestions.
Do not invent statistics, guarantees, testimonials, or customer facts.

## 17. AI actions and automation boundaries
Default AI behavior:
* Read authorized data.
* Explain.
* Draft.
* Suggest.
* Prepare an action for review.

Sending replies, publishing, exporting customer data, changing CRM records, and launching campaigns must use normal application permissions and approval rules.
Use explicit action previews or an administrator-configured bounded automation policy.
A valid automation policy must specify:
* Brands and channels.
* Allowed actions.
* Approved knowledge sources.
* Eligible message categories.
* Rate and spending limits.
* Escalation triggers.
* Expiry or review date.
* Emergency stop.

Initially enable automatic classification and routing before automatic customer replies.
Escalate unsupported requests, uncertain answers, complaints requiring judgment, and sensitive cases to a person.
Do not rely on model-reported confidence alone to authorize a reply.
Treat messages, comments, imported documents, and listening results as untrusted input. They cannot grant permissions or override system rules.
Provide no arbitrary SQL, shell access, unrestricted URL fetching, or secret retrieval tools.
Record model/provider, action trace, source references, latency, and usage without unnecessarily logging private message bodies.

## 18. Rules and automation
Provide a constrained rule builder:
* Trigger.
* Conditions.
* Actions.
* Scope.
* Schedule/business hours.
* Limits.
* Test preview.
* Enable/disable.
* Execution history.

Examples:
* New Google review → create inbox item.
* Unassigned support question → route to the care team.
* Case nearing its deadline → notify the assigned Slack channel.
* Confirmed issue → create an Asana task.
* Selected campaign brief → create a monday.com item.
* Approved content → create a Mailchimp draft.
* Mention spike → create a listening alert.

Prevent recursive triggers and synchronization loops.
External status updates must not bypass Relay approval policies.

## 19. Data and backend design
Extend existing services and tables instead of creating duplicate tenant or identity models.
Model the necessary entities, including:
* Connector installations and grants.
* Resource mappings and sync cursors.
* Conversations and channel identities.
* Messages, revisions, and attachments.
* Reply attempts.
* Cases, assignments, and service-level events.
* Saved replies.
* Listening queries, observations, and alerts.
* Source coverage.
* AI runs and proposed actions.
* Automation policies and execution history.

Keep provider identities separate from internal customer identities.
Use reliable linking and explicit merge/unmerge history. Never merge people solely by name.
Use PostgreSQL and the existing durable queue infrastructure first. Add separate search or processing infrastructure only when measurements justify it.
Preserve publication capacity while accommodating inbox traffic. Give customer replies and scheduled publications bounded capacity so bulk listening imports cannot starve them.

## 20. Security, administration, and MCP
Wire all modules into the admin app.
Expose:
* Connector health.
* Sync lag.
* Inbox backlog.
* Failed reply attempts.
* Service-level breaches.
* Listening coverage and ingestion failures.
* AI usage and budgets.
* Automation runs.
* Security and audit events.

Use scoped permissions for inbox reading, replying, assignment, case administration, listening, exports, AI actions, and integrations.
Platform operators do not automatically gain access to private customer conversations.
Add authenticated MCP tools for authorized reads, draft replies, assignments, case management, listening queries, and AI-assisted preparation.
External actions must reuse the same domain services, policy checks, and idempotency protections as the UI.
Enforce revocation across sessions, subscriptions, background tasks, search indexes, exports, and AI retrieval.
Document retention and deletion behavior for raw messages, attachments, summaries, embeddings, provider logs, and backups.

## 21. Design, mobile, and speed
Follow Relay's existing modern design system and concise UI-copy rules.
Keep settings and subsections in the left sidebar.
Do not introduce long explanatory paragraphs into operational screens. Keep detailed instructions in Help.
Test 320, 360, 390, 430, 768, 1024, and 1440 CSS-pixel widths.
Essential phone workflows must include:
* Reply to a conversation.
* Add an internal note.
* Assign and resolve a case.
* Review an AI reply.
* Translate a message.
* Inspect a listening alert.
* Create an external task.
* Reconnect an integration.

Preserve V3.1 performance budgets.
Load pages from stored, indexed data. Do not wait for external APIs or AI generation to render the interface.
Use bounded pagination, small realtime events, lazy-loaded charts, incremental search, background aggregation, cancellation, and quota-aware synchronization.
Measure performance honestly. Keep the app usable when AI or an external provider is unavailable.

## 22. Acceptance tests
Verify complete workflows:
1. Receive a supported message, assign it, draft a reply, send once, and display the actual provider result.
2. Two agents attempt to reply concurrently without silently sending duplicate responses.
3. An internal note never reaches the customer.
4. A Google review becomes an inbox item and an authorized reply reaches the correct location.
5. A case creates one linked HubSpot ticket despite repeated delivery.
6. Asana and monday.com updates synchronize without loops.
7. A Slack interaction rejects an unauthorized or revoked actor.
8. A Mailchimp export creates a draft without sending or subscribing anyone.
9. Translation preserves the original and does not automatically send.
10. A listening alert links to real observations and states its coverage.
11. AI answers use authorized sources and resist instructions embedded in customer content.
12. Membership revocation immediately blocks inbox and AI retrieval.
13. Provider outages produce recoverable states without invented success.
14. Main app, admin, and MCP show consistent persisted state.
15. All essential mobile workflows remain usable.

Test tenant isolation, webhook verification, message ordering, reply-window expiry, unknown send outcomes, retention, accessibility, and representative load.
Separate fixture-based tests from live verification. Use designated test accounts for authorized external tests.

## 23. Delivery sequence and documentation
Implement in this order:
1. Baseline audit and capability matrix.
2. Shared connector and event infrastructure.
3. One complete inbox adapter and customer-care workflow.
4. Remaining supported inbox capabilities.
5. Seven requested business integrations.
6. Connected-source listening.
7. Broader listening provider integration where access exists.
8. Relay AI and bounded automation.
9. Admin and MCP integration.
10. Mobile, security, reliability, and performance verification.

Do not silently drop later modules. Report externally blocked work precisely.
Create:
* V3.5 requirements and implementation matrix.
* Connector capability and permissions matrix.
* Inbox and customer-care guide.
* Listening coverage and metric definitions.
* AI behavior and automation guide.
* Data model and event-flow documentation.
* Security and retention documentation.
* Admin and operational runbooks.
* Mobile and performance reports.
* Test evidence.
* Implementation gaps.
* Final activation checklist.

Final reporting must distinguish:
* Implemented and locally tested.
* Verified against a live provider.
* Awaiting credentials or review.
* Awaiting licensed data access.
* Unsupported by the provider.
* Not implemented.

Begin with repository inspection and continue through implementation, verification, and documentation.
