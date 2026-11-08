# Test report (V1 + V1.1)

Environment: Linux container, Node 22.23, PostgreSQL 16 (Docker), SeaweedFS S3, Dex OIDC, Mailpit, Chromium (Playwright 1.63). Final run on 2026-11-07.

| Suite | Command | Result |
|---|---|---|
| Typecheck (packages, worker, tests) | `npx tsc -p tsconfig.json --noEmit` | Clean |
| Typecheck (web) | `cd apps/web && npx tsc --noEmit` | Clean |
| Unit + provider contracts | `pnpm test` | **235 passed** (16 files) |
| Integration (real Postgres + S3, disposable DB per run) | `pnpm test:integration` | **155 passed** (21 files) |
| Browser E2E (real OIDC sign-in, real worker) | `pnpm test:e2e` | **26/26 passed** in one run |
| Production web build | `pnpm --filter @social-lite/web build` | Pass |
| Docker images | `./scripts/build-images.sh v1` | web 1.09 GB, worker 1.13 GB (ffmpeg included for video); migration job, readiness and ffprobe verified |
| Production fail-closed | worker image with dev env + `APP_ENV=production` | Refused to start, listing 7 unsafe settings |
| Restore drill | `./scripts/restore-drill.sh` | Pass: counts match, dispatch disabled, reconciliation list produced (`evidence/restore-drill/`) |
| Load | `scripts/load-test.ts 100 25` (250 ms simulated provider latency) | 100 due at once → p95 start **2.6 s**, all done 3.1 s, 0 duplicate sends (`evidence/load/`) |

## Engine invariants covered (tests/integration/engine.test.ts)

Four-channel atomic schedule · Instagram text-only rejected · idempotent repeat → one schedule · concurrent workers → one send each · partial failure retry touches only failed · backoff + 5-attempt cap · lost response → Unknown, no resend, reconcile → Published · Telegram Unknown → manual resolve / acknowledged retry · crash mid-send → Unknown, crash pre-send → requeue, stale worker fenced · revoked credentials → Blocked + account flagged, others continue · X budget blocks only X · pause enforced at dispatch, resume, late resume → Expired · cancel before/after send · cancel during prepare stops before send · reschedule generation no-op · stale jobs expire · restore mode stops claims · DST gap/fold · approval binding/invalidation/dispatcher recheck · rejection reason · tenant isolation · role limits.

## V1.1 + hardening coverage

AI: fidelity validator (numbers/scores/dates preserved, prohibited phrases), atomic token reservations under concurrency, fixture mode refused in production · Media: video upload → worker → ffprobe validation → H.264/AAC transcode + metadata strip, malformed video rejected, carousel/album/video contract tests per provider with checkpoint resume · Slots: DST gap/fold, concurrent queueing takes distinct slots · Crops: approval invalidated by crop change, engine publishes cropped derivative · Analytics: quota/budget gating, unsupported ≠ 0 · Settings: owner-only, cross-tenant 404 · Meta deauthorize/data deletion with signed_request · forward-only webhook application · shared rate limiter exact under concurrency · KMS unwrap + fail-closed.

## Not run / limits

- **No live provider calls** (no credentials or test destinations). All publishing evidence is simulated.
- Seven-day pilot not run.
- Performance measured on one machine with simulated providers only.
- Automated tests are not a security certification or penetration test.

Evidence: `evidence/e2e/`, `evidence/ui-v2/`, `evidence/load/`, `evidence/restore-drill/`.
