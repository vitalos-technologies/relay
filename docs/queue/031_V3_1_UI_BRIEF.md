# V3.1 stream UI — screens for the V3.1 backend (lead → agent)

The V3.1 backend is done (DATA, GOV, PERF), and so is the V3 redesign. This stream builds the V3.1 screens on the redesigned
design system. The brief is `docs/queue/03b_V3_1_PROMPT.md`; this stream covers §3/§4 (browser side), §7–§16 UI and §18 browser tests.

## Read first
- `docs/V3_1_WORKSTREAMS.md`.
- `docs/V3_DESIGN_SYSTEM.md` (use its components; don't invent new styles).
- `docs/v3-progress/ux.md`.
- API contracts:
  - `packages/core/src/contracts/v31-{data,gov,perf}.ts`
  - `docs/V3_1_DATA_API.md`
  - GOV route table in `docs/v3-1-progress/gov.md`
- `docs/PERFORMANCE_BUDGETS.md` (route budgets) and `HANDOFF.md`.

## Screens
1. **Draft resilience (§9):**
   - Composer autosave states: Saving / Saved / Saved locally / Offline / Save failed. "Saved locally" ≠ saved.
   - Conflict dialog: yours vs server, keep both / take theirs.
   - Recovery prompt after refresh or restart; honour the workspace `draft_recovery` policy.
   - Revision history drawer.
2. **Trash and undo (§10):**
   - `/trash` (posts + assets): restore, consequences preview, retention days left.
   - Undo toasts after delete/archive/bulk.
   - Asset-in-use warnings.
3. **Bulk (§11):**
   - Multi-select in Planner list, History, Library.
   - Preview sheet: affected items, permission/policy consequences.
   - Job progress with per-item results, retry failed, cancel, undo.
4. **Global search + Cmd/Ctrl+K (§8):**
   - Posts, campaigns, assets, brands, settings destinations, recent items, quick actions (create draft…).
   - Keyboard first, debounced + cancellable, results cleared on workspace switch.
5. **Brand safeguards (§12):**
   - Settings → Publishing → Safety rules / brand profile: rules with advisory vs mandatory, phrases, footer/disclaimer, approved links/CTAs, logos/colours.
   - Rule-review queue with keep / will edit / cancel.
   - Composer findings: mandatory blocks Schedule/Publish with a clear reason.
   - Asset governance: expiry, superseded, licence notes.
   - TipSignal fact-preservation errors shown verbatim.
6. **Reuse + queues (§13):**
   - Duplicate as new draft with provenance.
   - Evergreen toggle.
   - Content queue page (pause, inspect, remove).
   - Similar-post warnings in the composer.
7. **Campaign links (§14):**
   - UTM defaults per brand/campaign.
   - Link builder in the composer with preview/override.
   - Short links.
   - Campaign measurement panel keeping the four measurement kinds separate ("unavailable" where not implemented).
8. **Diagnostics (§15):** per-connection test centre in Connections (read-only; no "test post" without an explicit separate action).
9. **Onboarding (§7):** resumable checklist on Overview for new workspaces, role-adapted, with the five readiness checks per connection.
10. **Release + support (§16):**
    - Feature flags admin (workspace-scoped).
    - Release notes view with an unread badge.
    - "Report a problem" with an explicit attachment choice and a redaction preview.
11. **Performance (§3/§4):**
    - Measure LCP/INP/CLS on a production build (`next build --webpack && next start`) for the core routes, with repeated runs.
    - Enforce route JS budgets from `PERFORMANCE_BUDGETS.md`.
    - Lazy-load charts, video previews and the Google Picker.
    - Write the browser section of `docs/PERFORMANCE_RESULTS.md` (sample counts, conditions, honest variance).

## Rules
- **Copy:** concise UI copy; no explanatory paragraphs on operational screens. Product name is Relay.
- **Data honesty:** never describe simulated behaviour as real; never mix demo data into live views.
- **Server truth:** the server is the authority.
  - Never trust client state for permissions.
  - Bulk / undo / recover go through the APIs (idempotency keys as documented).
- **Ownership:** you own `apps/web/**` UI. Ask the lead (in your report) for any service/API change; small additive route pass-throughs are fine.
- **Dev server:** the shared dev server currently runs a production build on :3000. While developing, stop it (`kill $(cat .data/web.pid)` and its child) and run `cd apps/web && npx next dev --webpack --port 3000`. Before E2E or perf runs, switch back to a production build. Never run E2E and the screenshot script at the same time (the dev server has been OOM-killed).
- **E2E:** tests run in the seeded "E2E Workspace" (Playwright globalSetup). Add E2E for autosave + conflict, trash restore, a bulk partial failure + retry, Cmd+K, a mandatory brand rule blocking Schedule, and the onboarding checklist.
- **Git:** no git commits; the lead commits.
- **Progress note:** keep `docs/v3-1-progress/ui.md` current. Container restarts happen, so it is your resume point.
- **Screenshots:** save checkpoint screenshots as each area lands, to `evidence/v3-1/ui/checkpoints/<n>-<area>-<theme>.png` (1440, deviceScaleFactor 2), plus 390px for the phone workflows.
- **Verification:**
  - root and web `tsc` clean
  - `pnpm test` green
  - full E2E on a production build
  - screenshots of every new screen at 1440 and 390, light + dark
