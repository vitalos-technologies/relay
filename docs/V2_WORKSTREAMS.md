# V2 workstreams — contracts and ownership

Read first: `docs/V2_THREAT_MODEL.md`, `docs/PERMISSIONS_MATRIX.md`, `packages/core/src/authz.ts`, `packages/services/src/{authz,tenancy,context}.ts`, `packages/db/migrations/009_v2_authz.sql`, `docs/WORKSTREAMS.md` (V1 conventions still apply), and the V2 spec `/root/.claude/uploads/f609c563-89be-5dc6-9e00-6441979fd790/053d4b00-Social_Lite_V2_Autonomous_Upgrade_Prompt.md`.

## Shared contracts (do not change without the lead)

- **Authorization**: every server path calls `requireAction(ctx, permission, { brandId?, connectionId?, stepUp? })` / `authorizeCtx()` / `assertBrand()` from `services/tenancy.ts`. V2 permission identifiers are in `core/authz.ts`. Never check `ctx.access.role` for authorization in new code; migrate old uses you touch. Deny by default; errors 404 for invisible resources, 403 `forbidden` / `mfa_required`, 401 `step_up_required`.
- **Policy version**: any change to grants, memberships, teams, restrictions or security policy calls `bumpPolicyVersion(tx, workspaceId)` in the same transaction and writes an audit event (actor, workspace, resource, action, safe before/after, result, correlation id).
- **Session assurance**: `sessions.mfa_verified`, `auth_time`, `acr`, `amr` are written ONLY by the OIDC callback from the verified ID token. Never accept assurance, roles, tenant ids or actor from the client.
- **Tests**: V2 behaviour must be tested through `v2Ctx()` (real policy path) in `tests/integration/helpers.ts`, not `ctxFor()`.
- **Migrations**: each stream owns ONE file number below; never edit another's or earlier migrations.
- No `pnpm add` without telling the lead in your report (install only if essential and nobody else is installing; run `pnpm install` serially); no git commits; don't restart shared servers on :3000/:3001 or stop Docker.
- UI: simplified style (minimal text, tooltips, lime accent only for primary action, no subtitles); every security button must really work; never show success before the server commits. Screenshots → `evidence/v2/<area>-*.png`.

## Streams

| Stream | Migration | Owns |
|---|---|---|
| A Identity & security | `010_v2_identity.sql` | Keycloak (replace Dex in infra), `services/auth/**` (OIDC assurance, step-up, sessions, back-channel logout), My Security page, MFA/recovery/passkeys via IdP, service accounts + API keys, TipSignal → service account, DB least-privilege roles, CSP/security headers, dependency/secret scans |
| B Tenancy & lifecycle | `011_v2_tenancy.sql` | teams, grants/restrictions API, delegation, invitations v2 (72 h, resend, bulk, guest expiry, atomic accept), suspension/removal/scope reduction, handover + reassignment, last-owner + ownership transfer, effective-access view, publication authority (record at schedule, revalidate/hold/adopt at dispatch), migrate remaining `ctx.access.role` uses, session-info permissions, workspace switch cache clearing, V2 seed fixtures |
| C Collaboration | `012_v2_collaboration.sql` | campaigns, assignments, comments (internal vs shared), mentions, review requests, version history, approval policies (0/1/2 stages, quorum of distinct eligible people, separation of duties, policy generation binding), guest review portal, notification preferences (digest, quiet hours, critical), approval inbox, calendar ownership |
| D Product & fairness | `013_v2_product.sql` | account health centre, publishing readiness preflight, duplicate/collision warning, usage budgets + atomic reservations (AI, storage, exports, provider calls) per workspace/team, fair scheduling across workspaces, activity/security centre (filters + permitted export), client handover export |
| Lead | – | contracts, integration, adversarial test suite, migration rehearsal, docs, final verification |

Shared-file rule: `posts/scheduling.ts`, `engine/process.ts`, `engine/claim.ts`, `apps/web/components/composer/*`, `components/shell/*` may be edited by more than one stream — re-read immediately before each edit, keep diffs small and additive, put new logic in your own files.
