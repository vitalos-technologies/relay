# Relay V5 — marketing site, two plans + trial, support widget, AI workspace

Queued 2026-11-08 by the user ("queue v5 next"). Runs **after V4** (it reuses V4's billing provider interface, plans/
entitlements and Platform → Support) and **before** copy cleanup (03e) and Docs + Help Centre (04).

> **Attachments.** The marketing mockup was shared in chat; it is transcribed in
> `docs/brand/V5_MARKETING_MOCKUP_NOTES.md` (layout, components, colours, and which mockup sections must NOT be built). The
> Claude.ai screenshot for the AI workspace did not reach the repo; build from §11's written pattern unless the user adds
> it as `docs/brand/v5-ai-reference.<ext>`.

---

Implement Relay V5 in the existing repository.
Deliver four connected outcomes:

1. A lightweight, modern, single-page marketing website.
2. Two monthly, per-user subscription plans with a 14-day free trial.
3. A support chat widget connected to Relay’s Platform support inbox.
4. A redesigned AI assistant that can carry out authorized workflows.

Preserve all previously implemented product capabilities, security, tenant isolation, billing safeguards, collaboration,
admin functionality, and performance requirements.
Inspect before building. Improve existing implementations where present; create missing functionality without introducing
competing systems.
Proceed autonomously through implementation, testing, and documentation. Consolidate genuinely missing external
configuration in a final activation checklist.

## 1. Visual references and branding
Use the user’s attached marketing mockup as the primary visual reference.
Use https://www.hootsuite.com/ as secondary inspiration for presenting product capabilities. Do not copy its wording,
branding, illustrations, or page verbatim.
Use the product name Relay, not SocialFlow or Social Lite.
Preserve the attached mockup’s main qualities:

* Clean white background.
* Strong dark typography.
* Purple primary actions.
* Restrained lavender and pink accents.
* Spacious hero with a large product visual.
* Rounded feature panels.
* Compact illustrated product demonstrations.
* Clear pricing cards.
* Short, scannable copy.

Use subtle gradients only where they support the supplied visual direction. Avoid excessive glow, animated backgrounds, and
visual noise.
Use the existing Relay logo assets where available.
Do not reproduce the mockup as a single flattened image. Build responsive, accessible components.
Do not copy its invented customer statistics, testimonials, ratings, or customer logos.

## 2. Component implementation
Use:

* The existing React/Next.js and TypeScript architecture.
* shadcn/ui components.
* Base UI primitives where appropriate.
* Motion for React.
* Existing styling tokens and Tailwind setup where applicable.

Check the installed versions and current official documentation before implementation.
Prefer compatible shadcn components backed by Base UI where available. Avoid wrapping two competing interactive primitives
around the same control.
Preserve existing working components unless there is a clear reason to change them.
Create reusable components for:

* Navigation.
* Buttons and links.
* Feature cards.
* Product previews.
* Pricing cards.
* FAQ accordion.
* Support widget.
* AI composer.
* Suggested actions.
* Task progress.
* Results and action previews.

Keep motion brief and purposeful. Respect reduced-motion preferences and keep content visible when animation is disabled.

## 3. One-page website and navigation
If a marketing website exists, upgrade it. Otherwise create it.
Use one public landing page at the appropriate existing root route.
Marketing navigation must scroll to sections on the same page:

* Product.
* AI.
* Integrations.
* Pricing.
* FAQ.

Only primary account navigation should leave the marketing page:

* Sign up.
* Log in.
* Dashboard for authenticated users.

Do not create separate product, solutions, pricing, or marketing-resource pages.
“Explore” links must scroll to the relevant section or open an accessible inline preview.
“Watch demo” must open a lightweight demonstration on the page. If no genuine demo exists, use “Explore Relay” and scroll
to the product demonstration.
Keep necessary privacy and terms accessible through existing legal destinations or an accessible on-page presentation. Do
not remove necessary information merely to achieve one-page navigation.
Do not automatically redirect signed-in users away from the marketing page. Show “Open dashboard.”
Preserve existing application routes and safe authentication return paths.

## 4. Page structure
Build these sections in order.

**Header**
* Relay logo.
* Compact section navigation.
* Log in.
* Start free trial.
* Open dashboard when appropriate.
* Accessible mobile menu.

**Hero**
Suggested headline: “Your social world. Working together.”
Suggested supporting line: “Plan content, manage conversations, and get work done with AI.”
Actions:
* Start free trial.
* Explore Relay.

Add a polished product preview inspired by the supplied mockup.
Show an illustrative planner, inbox, or AI task result using synthetic demonstration content. Do not present demo metrics
as real customer outcomes.

**Capability strip**
Four concise items:
* Plan.
* Engage.
* Understand.
* Collaborate.

**Product demonstrations**
Use four substantial visual cards:
* Publishing and scheduling.
* Social inbox and customer care.
* Analytics and listening.
* AI assistant.

Each card should contain a short title, one useful sentence, and a meaningful product preview.
Demonstrate useful interactions without loading the authenticated application or private customer data.
Clearly distinguish available functionality from capabilities that still require provider access.

**Integrations**
Show relevant, implemented integrations using recognizable icons.
Label this section “Connect your tools,” not “Trusted by.”
Do not imply endorsement or customer relationships.
Identify limited or pending capabilities where necessary. Do not market an unimplemented connector as operational.

**Pricing**
Exactly two plans, as defined below.

**FAQ**
Use a compact accordion covering:
* How the trial works.
* How per-user pricing works.
* Supported channels.
* Adding teammates.
* Cancellation.
* AI and integration usage limits.

Answers must match the actual implementation.

**Final action and footer**
A short final invitation to start a trial.
Keep the footer minimal: Relay branding, section anchors, account actions, support, and necessary legal access.
Do not add fake testimonials, invented growth numbers, or filler sections to match the mockup’s length.

## 5. Exact pricing requirements
Replace conflicting public pricing with:

| Plan | Price |
|---|---|
| Standard | £10 per user / month |
| Professional | £25 per user / month |

Both plans offer: **14 days free**.

Requirements:
* Currency: GBP.
* Billing interval: monthly.
* Price is per billable user.
* Exactly two publicly purchasable plans.
* No invented annual discount.
* No third Business or Enterprise pricing card.
* Existing legacy subscriptions must not be silently repriced.

Use one plan catalogue shared by marketing, checkout, billing settings, entitlements, and Platform admin.
Do not hard-code separate prices across screens.
Define a billable user as an active accepted workspace member, including the owner. Pending invitations and Relay support
operators are not billable. Service accounts are not human seats.
Any guest exemption must be explicit and constrained; do not create an unlimited free-member loophole.
Require at least one paid seat for an active paid workspace subscription.
Show the number of seats and total recurring price before purchase or seat increases.
Example acceptance calculation:
* Three Standard users: £30 per month.
* Three Professional users: £75 per month.

Display any applicable tax treatment consistently with the configured checkout. Do not claim tax-inclusive or
tax-exclusive pricing without implementing the corresponding configuration.

## 6. Plan capabilities
Use this initial product distinction, mapped to real implemented features.

**Standard**
* Publishing and scheduling.
* Shared calendar.
* Media library.
* Team collaboration.
* Standard analytics.
* Supported social inbox workflows.
* Basic AI drafting assistance.
* In-app support.

**Professional** — everything in Standard, plus:
* Advanced analytics and reports.
* Listening features available through activated sources.
* Advanced approval and customer-care workflows.
* AI workflows that perform multiple steps.
* Configured automations.
* Advanced business integrations and MCP capabilities.

Inspect existing entitlements before applying this mapping. Preserve paid customer rights and document migration behavior.
Maintain configurable allowances for costly resources such as AI, listening, storage, and external API usage.
Do not advertise unlimited usage or imply that paid third-party data licences are included automatically.
Keep the pricing cards short. Put detailed allowances in an expandable comparison on the same page.
Do not charge for a prominently advertised capability that is unavailable without making that limitation clear.

## 7. Trial implementation
Both Standard and Professional must support a 14-day free trial.
Default to a no-card-required trial unless an already established product policy explicitly requires a card. Marketing
language must reflect the actual flow.
Requirements:
* Start the trial when the first eligible workspace trial is activated.
* Persist the start and exact expiry timestamps server-side.
* Trial the selected plan’s capabilities with bounded trial allowances.
* Joining a workspace does not restart its trial.
* Changing plans does not reset the expiry.
* Refreshing, repeating checkout, or replaying requests does not create another trial.
* Record trial eligibility and redemption server-side.

When a customer subscribes during the trial, make the first charge date explicit and preserve the promised free period.
At expiry without a subscription:
* Restrict paid actions under the documented lifecycle policy.
* Preserve customer data.
* Keep billing, support, and appropriate export access available.
* Clearly mark affected scheduled work.
* Do not silently publish, delete, or discard held jobs.

Do not claim a trial is unlimited. Apply reasonable disclosed resource limits.

## 8. Billing and seat synchronization
Reuse the existing billing provider integration.
Use test mode during development.
Implement:
* Selected-plan handoff from the marketing page.
* Trial registration.
* Checkout.
* Seat quantity.
* Plan changes.
* Renewal cancellation.
* Billing self-service.
* Verified webhook processing.
* Reconciliation.
* Shared entitlement enforcement.

Treat the provider’s verified state as billing evidence. A success redirect is not payment confirmation.
Apply idempotency and concurrency protection to checkout, seat updates, and webhook processing.
Before an action increases paid seats, show the cost consequence and require an authorized billing actor.
Define effective timing for seat reductions and plan downgrades. Preserve appropriate access until the configured change
takes effect.
Verify marketing, checkout, customer settings, and Platform admin display consistent prices, seats, dates, and status.
Do not activate live billing without existing authorization and configured live products.

## 9. Marketing support widget
Add a lightweight chat launcher connected to the existing Platform → Support service.
This is communication with Relay staff, not the customer’s social inbox.
Support both visitors and signed-in users.

**Visitors** — allow a visitor to:
* Start a conversation.
* Enter a name and contact email.
* Send a message.
* See responses in their authorized browser session.

Assign an unguessable visitor identity with secure session handling.
Email entry alone must not prove identity or grant access to existing tickets.
Cross-device ticket access requires a secure verification flow.
Do not automatically merge visitor conversations into an account solely because the email text matches.

**Signed-in customers**
Use trusted account and workspace context.
Let users choose their relevant workspace when necessary.
Do not trust workspace identifiers supplied by the widget without server authorization.

**Platform staff** — new widget messages must appear in Platform → Support with:
* Visitor or customer identity.
* Workspace when authenticated.
* Source: marketing widget.
* Assignee.
* Conversation history.
* Reply state.
* Safe diagnostics.

Staff replies must return to the widget and trigger configured notifications.
Internal notes must never reach the widget.
Show “Send us a message” when no staffed live-chat availability is established. Do not invent an online status or
response-time promise.
Use typing and read indicators only when backed by real events.

## 10. Widget reliability and mobile behavior
Reuse the support message service and durable notification pipeline.
Implement:
* Deduplicated message submission.
* Reconnect and missed-message recovery.
* Loading, offline, retry, and error states.
* Rate limits and abuse controls.
* Authorized private attachments.
* Minimal diagnostic collection.
* Secure session expiration.
* Clear privacy information.

Lazy-load the widget after interaction or an appropriate idle period.
It must not delay the hero or initial page rendering.
On mobile, open an accessible sheet or full-screen conversation with a close button.
Do not cover pricing actions, cookie controls, or essential navigation.

## 11. Redesign Relay AI as a full workspace
Use the broad interaction pattern of a focused assistant application, inspired by the user’s Claude.ai reference:
* Spacious central composer.
* Short welcome message.
* Relevant suggested tasks directly below the composer.
* Conversation history in a collapsible left sidebar.
* A working area for generated results.
* Clear progress while tasks run.

Use original Relay styling and wording. Do not copy Claude branding or claim identical capabilities.
Keep the existing application navigation and left-sidebar settings conventions coherent.

**Composer controls**
* Brand/workspace context.
* Attach files.
* Select authorized knowledge sources.
* Enter a task.
* Submit.
* Stop an active run.

Show selected context clearly.
Do not expose technical model controls unless they help the user make a meaningful choice.

## 12. Relevant actions below the chatbox
Display four to six context-aware suggestions, for example:
* Plan this week’s posts.
* Turn this document into a campaign.
* Draft replies to unanswered messages.
* Explain this month’s performance.
* Find topics worth posting about.
* Create platform-specific versions.

Adapt suggestions to:
* Current brand.
* Connected accounts.
* Available documents.
* User permissions.
* Plan capabilities.
* Actual product data.

Do not suggest publishing to an unconnected account or analyzing unavailable listening data.
Clicking a suggestion should populate a useful task or open a short task-specific input flow.
No decorative suggestion buttons that do nothing.

## 13. Implement agent-like execution
The assistant must perform authorized tasks through real application services.
Use an execution lifecycle such as:
* Preparing.
* Working.
* Needs input.
* Needs review.
* Completed.
* Partially completed.
* Failed.
* Cancelled.

Display concise progress events such as:
* “Reading the selected brief.”
* “Creating three channel drafts.”
* “Checking account requirements.”
* “Saved three drafts.”

Show observable actions and results, not hidden model reasoning.
Persist execution state so refreshes and temporary disconnections do not lose the run.
Support safe retries, cancellation, timeout handling, and partial results.
Stopping a run must stop undispatched work. Explain any action already completed or in flight.
Do not automatically rerun successful external actions when resuming a failed task.

## 14. Required AI workflows
Implement at least these complete workflows.

**Campaign from a brief**
* Read an authorized selected source.
* Produce a campaign outline.
* Generate channel-specific drafts.
* Validate available destinations.
* Save drafts through the existing service.
* Return links to the actual created records.

**Inbox assistance**
* Read selected authorized conversations.
* Summarize the issues.
* Draft appropriate replies.
* Flag missing information.
* Present replies for review.

**Performance analysis**
* Query authorized stored analytics.
* Explain the observed changes.
* Show dates, coverage, and evidence.
* Suggest next actions.
* Offer to create related drafts or tasks.

**Weekly planning**
* Inspect the selected brand’s calendar and approved content.
* Propose a practical schedule.
* Identify conflicts or missing assets.
* Create drafts.
* Prepare scheduling actions according to permissions and approval rules.

**Content adaptation**
* Convert approved source material into supported formats.
* Preserve important facts.
* Apply brand guidance.
* Save variants without overwriting approved revisions.

## 15. Action permissions and result previews
Reading, drafting, and saving authorized internal drafts can proceed without repeated confirmation.
External actions must follow the existing action-preview or bounded-automation policy:
* Publishing.
* Sending replies.
* Exporting private content.
* Updating external CRM records.
* Launching email campaigns.
* Changing billing or account access.

The assistant cannot bypass approval requirements.
Use structured result cards with useful actions:
* Open draft.
* Edit.
* Compare versions.
* Review reply.
* View report.
* Submit for approval.
* Review schedule.

Preview exact destinations, content, and timing for consequential actions.
Bind execution to the reviewed revision and recheck permissions at dispatch.
Treat source documents and customer messages as untrusted content. They cannot grant permissions or override policies.

## 16. Admin integration
Add V5 controls to existing Platform and Workspace administration.
Include:
* Marketing configuration.
* Shared pricing catalogue.
* Trial status and eligibility.
* Seat and entitlement diagnostics.
* Widget support conversations.
* AI run history and failures.
* Model usage and budget controls.
* Feature availability.
* Audit records.

Keep customer content protected. Platform operators should see operational metadata unless permitted support access
applies.
Do not add a public settings API that exposes private billing or model credentials.

## 17. Performance and accessibility
The marketing page must remain lightweight.
Use:
* Static or server-rendered public content.
* Optimized product imagery.
* Reserved image dimensions.
* Limited font loading.
* Lazy-loaded below-the-fold previews.
* Small interactive components.
* No heavyweight autoplay video.
* No full-app bundle on the marketing page.

Preserve the V3.1 performance targets and measure them under documented conditions.
AI responses may stream, but typing, scrolling, and navigation must remain responsive.
Load conversation histories incrementally. Keep long task execution off the page request path.
Test keyboard navigation, screen-reader names, focus management, reduced motion, contrast, and 200% text zoom.
Test responsive layouts at 320, 360, 390, 430, 768, 1024, and 1440 CSS pixels.

## 18. Acceptance tests
Verify:
1. Marketing section links stay on the same page.
2. Signup, login, and dashboard links reach the correct routes.
3. The page uses Relay branding and the supplied visual direction.
4. No fabricated customer endorsements or outcomes appear.
5. Exactly two public plans show £10 and £25 per user per month.
6. Both plans provide a genuine 14-day trial.
7. Seat totals match across marketing handoff, checkout, billing, and admin.
8. Trial expiry and plan changes do not reset trial eligibility.
9. Visitor messages reach Platform support.
10. Staff replies return to the correct widget conversation.
11. Another visitor cannot access that conversation.
12. Internal support notes never appear publicly.
13. AI suggestions are relevant and actionable.
14. AI workflows create real records with working links.
15. Runs survive refresh and handle cancellation and partial failure.
16. Publishing and customer replies respect existing permissions.
17. Mobile workflows are usable with the on-screen keyboard.
18. Performance and accessibility results are recorded honestly.

Use test billing and designated test accounts. Do not send real campaigns or charge real customers during verification.

## 19. Delivery
Create or update:
* V5 implementation matrix.
* Marketing page guide.
* Plan and seat definitions.
* Trial and subscription lifecycle.
* Support widget security and operation.
* AI tools and execution model.
* Mobile QA evidence.
* Performance report.
* Test report.
* Remaining implementation gaps.
* Final activation checklist.

The final report must distinguish implemented, tested, externally verified, and awaiting activation.
Do not stop after delivering a visual mockup. Complete the marketing-to-signup flow, pricing integration, support
messaging, and working AI task execution.
Begin by inspecting the repository and existing application.

## Lead notes (sequencing with V4)
- V4 (`03g_V4_PROMPT.md`) builds the billing provider interface, plans, entitlements, trials and Platform → Support. V5
  **reprices and narrows** that catalogue to exactly Standard £10 / Professional £25 per user per month, 14-day trial. If V4
  defines other public plans or prices, V5 replaces them in the single shared catalogue and keeps any existing
  subscriptions on their old prices (legacy, not purchasable).
- No Stripe keys in this environment: keep building against the provider interface + test double + locally signed webhook
  fixtures; live products/prices are an activation item.
- The AI workspace extends the V3.5 assistant (`docs/v3-5/*`, AI run tables) rather than adding a second run system. With
  no AI provider key, workflows must report "AI is not set up" honestly; deterministic steps (reading sources, validating
  destinations, saving drafts) are still real and tested with a fake model provider in tests only.
