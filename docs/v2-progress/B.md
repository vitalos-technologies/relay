# Stream B — Tenancy & lifecycle (progress)

Migration: `packages/db/migrations/011_v2_tenancy.sql` — APPLIED to dev DB 04:07 by stream A (checksum d2316241…). FROZEN: never edit.

## Done (code written)
- [x] 011 migration: invitations v2 cols, ownership_transfers, connections.verification_*, publication_authorizations (+immutability trigger, backfill), adoption_events
- [x] services/grants.ts (normalize/delegate/upsert/legacy summary/commitPolicyChange), access.ts (effective access, canAnywhere)
- [x] members.ts (V2 list/grants/restrictions/legacy PATCH), lifecycle.ts (suspend/reactivate/remove/scope/handover/reassign/ownership)
- [x] teams.ts, auth/invitations.ts v2 (72h, resend rotates token, bulk, guest expiry, identity-bound atomic accept)
- [x] engine/authority.ts + hooks: scheduling.ts (createScheduleTx/approve/reschedule), process.ts gate, hooks.ts (reconnect never releases authority holds)
- [x] role→V2 migration: scheduling, posts/service flags, manual retry, slots, ai, readmodels, assets, oauth callback; tenancy legacy fallback → presets
- [x] workspaces.sessionInfo: V2 flags (`v2`), legacy flags from V2, suspended excluded; createWorkspace writes owner grant; assertExpectedWorkspace

- [x] tests green: v2-teams-grants (7), v2-lifecycle (10), v2-authority (6); members/tenancy/slots moved to V2 semantics
- [x] routes: api/{members/**,grants,restrictions,teams/**,invitations/{bulk,accept,[id]/resend},workspace/ownership-transfers/**,publication-holds,schedules/[id]/adopt}
- [x] client: X-Workspace-Id + workspace_changed reload, lib/client/workspace-sync.ts (clear caches + BroadcastChannel), session canV2/canOn
- [x] UI: app/(app)/team/{page,members/[userId],invitations,teams,teams/[id],held}; nav item; settings Team tab → link
- [x] seed: scripts/seed-v2-tenancy.ts (called from seed.ts); scripts/seed-v2-apply.ts applied to dev DB (04:2x)
- [x] screenshots evidence/v2/team-*.png (13; dev server :3000, sessions inserted directly)
- [x] verify: tsc root 0 / web 0 errors; pnpm test 418/418; integration 243/244 (only setup.test OIDC=Dex issuer → stream A)
## Status: DONE (report sent)

## Notes
- Authority hold: deliveries state 'blocked', last_error_code 'authority_hold', blocked_reason = message. Released only by adoptPublication().
- Stream C: if approve() is rewritten, keep `recordPublicationAuthority(... basis:'approval' ...)` in the activation path.
