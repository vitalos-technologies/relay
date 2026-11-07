# V2 threat model (compact)

Scope: Social Lite web + worker + PostgreSQL + object storage + identity provider + four social providers. Status of each control is tracked in `V2_REQUIREMENTS_MATRIX.md`; this page records threats, controls and residual risk.

## Assets

Provider tokens (can publish as a brand) · unpublished content and internal notes · media · membership/grant data · audit log · API keys (TipSignal) · key-encryption keys.

## Actors

| Actor | Can | Must not |
|---|---|---|
| Workspace owner/admin | Administer their workspace; see every brand in it | Read stored tokens; bypass required approval; remove the last owner (admin) |
| Team manager | Manage their team within a delegation ceiling | Grant roles/brands beyond the ceiling or to themselves |
| Brand-scoped member (editor, approver, publisher…) | Act on assigned brands per preset | See other brands/workspaces; approve own revision under separation of duties |
| Guest / client reviewer | Read and comment/approve explicitly shared review items until expiry | Library, internal notes, account details, other posts |
| Service account (TipSignal) | Create drafts on one brand | Publish, read content, manage anything |
| Authenticated attacker in another tenant | Own tenant only | Any cross-tenant ID substitution |
| Holder of a stolen session | Low-risk actions until idle/absolute timeout | Sensitive actions (step-up + MFA required); survives revocation |
| Malicious uploader | Upload to own brand | Polyglots, decompression bombs, SSRF via media URLs |
| Platform operator | Infrastructure | Silent content impersonation (no support-access feature exists) |

## Trust boundaries

1. Browser → web API: session cookie + CSRF + Origin; every request re-authorized from the database (no permission cache across requests).
2. Web/worker → PostgreSQL: least-privilege roles (app, worker, migrator).
3. Worker → providers: allow-listed hosts; mock transport impossible for live connections.
4. Identity provider → app: OIDC code + PKCE + nonce; assurance (`acr`/`amr`/`auth_time`) taken only from the verified ID token.
5. Inbound webhooks / TipSignal: signature + replay window + dedupe; tenant from the registered integration, never the payload.

## Threats → controls

| # | Threat | Control |
|---|---|---|
| T1 | Cross-tenant/brand ID substitution (API, export, media, jobs) | Composite FKs `(workspace_id,id)`; `authorize()` on every path; permissions re-checked per touched brand; worker re-gates at dispatch |
| T2 | Privilege escalation via invites/role edits/team changes | `canDelegate()` ceiling; no self-grant; server derives actor/role/tenant; owner role only via transfer flow |
| T3 | Removed/suspended user keeps acting from open tabs | Membership status checked on every request; policy version bump; queued work by removed scheduler is held for adoption |
| T4 | Approval bypass (own approval, double-counting, publisher shortcut) | Approval binds revision+assets+destinations+schedule+policy generation; distinct eligible approvers; separation of duties; dispatch re-check |
| T5 | Stolen session / weak factor | IdP MFA (TOTP/passkey), step-up freshness for sensitive actions, 30 min idle / 12 h absolute, session list + revoke |
| T6 | Recovery as a bypass | Provider-managed recovery codes; admins cannot remove another user's MFA; documented owner-lockout via IdP admin |
| T7 | Guest data leakage (internal notes via API/notifications/exports) | Comment visibility types; guest preset lacks `comments.internal`/library; notification recipients re-authorized at send |
| T8 | API key theft / over-scoped integration | Hash-only storage, shown once, prefix lookup, expiry/revocation, `integration` preset = draft-only on one brand |
| T9 | Token/secret exposure in logs, errors, exports | Redaction, envelope encryption, KMS custody, write-only secrets, CSV injection guard |
| T10 | Duplicate publication on retries/restarts/restores | Unchanged V1 engine guarantees (fencing, Unknown, restore mode) |
| T11 | Noisy tenant starves others | Per-connection claim limit + per-workspace concurrency/fair ordering, budget reservations |
| T12 | Policy service failure | `authorize()` fails closed; no owner fallback |

## Residual risks (accepted / documented)

- Workspace owners/admins can see all brands in their workspace; a separate client workspace is the strong boundary.
- Ordinary presigned media URLs remain valid until TTL (≤ 5 min previews; provider-fetch URLs up to 1 h) after access is revoked.
- Audit log is append-only for application roles; a database superuser can still rewrite history (no external immutable sink configured).
- Emails already sent cannot be recalled; they contain minimal content.
- Automated tests and scans are not a penetration test or certification.
