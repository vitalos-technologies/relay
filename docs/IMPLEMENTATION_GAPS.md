# Implementation gaps

Unfinished engineering only. External setup is in [FINAL_ACTIVATION_CHECKLIST.md](FINAL_ACTIVATION_CHECKLIST.md).

**All V1 and V1.1 engineering items are implemented and locally verified.** What remains cannot be completed without external access or elapsed time:

| Item | Why it is open | Next step |
|---|---|---|
| Live provider publication (all four) | No credentials or designated test destinations | Activation checklist §5 canaries |
| Live verification of video/carousel/Reels processing limits | Simulated providers only | Same canaries with a short test clip |
| Live provider metrics | Requires approved scopes (Meta insights) and X credits | After activation |
| Seven-day pilot | Needs a week of operation | Run per OPERATIONS.md |
| Performance in staging | Measured on one machine with simulated providers | Re-run `scripts/load-test.ts` against staging with real latency |
| Telegram webhook-based reconciliation | Implemented, but only active if the operator opts into a bot webhook (an existing webhook is never overwritten) | Optional |

Known design limits (documented, not defects): Telegram cannot reconcile without a webhook (manual resolution path exists); X reconciliation and metrics are billable reads and are budget-gated; previews are approximate.
