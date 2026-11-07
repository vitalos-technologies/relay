# Implementation gaps

Unfinished engineering only. External setup is in [FINAL_ACTIVATION_CHECKLIST.md](FINAL_ACTIVATION_CHECKLIST.md).

## MVP

| Gap | Impact | Next step |
|---|---|---|
| Live provider publication not exercised | Adapters are verified only against simulators + recorded-request contracts | Run canaries once credentials/test destinations exist (activation §5) |
| ~~X token revocation~~ | Done: best-effort revoke on disconnect (contract-tested) | – |
| Meta data-deletion / deauthorise callbacks not implemented | Required before external customers | Add `/api/webhooks/meta/deauthorize` + deletion status page |
| Webhook receipts are stored and deduplicated but not applied to deliveries | Publishing does not depend on them; no status updates from webhooks | Map Meta feed/IG webhooks to Processing/Unknown reconciliation (forward-only) |
| ~~CSV import UI~~ | Done: Compose → Import CSV | – |
| TipSignal binding is configured by SQL/seed, not UI | Owner cannot change the bound brand in-app | Settings → Integrations |
| Workspace X budget caps set by SQL | No UI to edit caps | Settings → Budgets (owner) |
| Rate limiting is per process | Fine for one host; weaker with multiple web replicas | Move buckets to Postgres if scaled out |
| KMS key provider | Env-held KEK only (`EnvKeyProvider`) | Implement `KeyProvider` for Cloud KMS |
| Seven-day pilot | Cannot be done in a one-day build | Run per OPERATIONS.md; record acceptance report |
| Performance targets measured only with simulated providers on one machine | Real provider latency/limits differ | Re-measure in staging |

## V1.1 not implemented

| Item | Status |
|---|---|
| CSV import | **Implemented + tested** (API + Compose dialog) |
| TipSignal signed events → drafts + deterministic graphics | **Implemented + tested** (binding via SQL) |
| AI caption rewriting (explicit acceptance, caps) | Not implemented |
| Multi-image, video, Reels, albums | Not implemented (adapters reject >1 image) |
| Posting slots / queues, image crops | Not implemented |
| Native analytics with quota controls | Not implemented |
