#!/usr/bin/env bash
# Grep-based secret scan of git-tracked files (no external scanner needed). Exit 1 on any unexplained hit.
# Known local-only development values (compose/realm/.env.example placeholders, test fixtures) are allow-listed
# below by exact value — they only work against the disposable local stack.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { echo "✖ $1"; echo "$2" | sed 's/^/    /'; fail=1; }

# 1) Environment files must never be tracked (only .env.example).
envs=$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '\.env\.example$' || true)
[ -z "$envs" ] || report "tracked env files" "$envs"

# 2) High-confidence credential formats.
PATTERNS=(
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
  '\b(AKIA|ASIA)[0-9A-Z]{16}\b'
  '\bgh[pousr]_[A-Za-z0-9]{36,}\b'
  '\bgithub_pat_[A-Za-z0-9_]{40,}\b'
  '\bxox[abprs]-[A-Za-z0-9-]{10,}\b'
  '\bAIza[0-9A-Za-z_-]{35}\b'
  '\bsk-ant-[A-Za-z0-9_-]{20,}\b'
  '\bsk-(proj-)?[A-Za-z0-9]{32,}\b'
  '\b(sk|rk)_live_[A-Za-z0-9]{16,}\b'
  '\bEAA[A-Za-z0-9]{40,}\b'
  '\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b'
  '\bsl_live_[a-z0-9]{12}_[a-f0-9]{64}\b'
  '\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b'
)
# Public documentation examples used as test fixtures (e.g. the Telegram Bot API docs' sample token).
EXAMPLES='123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ'
for p in "${PATTERNS[@]}"; do
  hits=$(git grep -I -n -E -e "$p" -- . ':!pnpm-lock.yaml' ':!scripts/secret-scan.sh' | grep -v -F "$EXAMPLES" || true)
  [ -z "$hits" ] || report "pattern $p" "$hits"
done

# 3) Secret-looking assignments with a literal value, minus the documented local-only development values.
ALLOW='socialite-local-only|socialite-(app|worker|migrator)-local-only|socialite-kc-admin-local-only|social-lite-local-client-secret|socialite-local-secret-not-for-production|socialite-demo|socialite-demo-totp-[a-z-]+|local-dev-1:|change-me|example|placeholder|test-secret|not-a-real|xxxx|\$\{|process\.env|<[^>]+>|Buffer\.alloc|randomBytes'
assign=$(git grep -I -n -i -E -e '(secret|password|passwd|token|api[_-]?key|private[_-]?key|client[_-]?secret)["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9+/_=.:-]{20,}["'"'"']' \
  -- . ':!pnpm-lock.yaml' ':!scripts/secret-scan.sh' ':!tests/**' ':!evidence/**' ':!docs/**' | grep -v -E -i "$ALLOW" || true)
[ -z "$assign" ] || report "literal secret assignments outside tests/docs" "$assign"

if [ "$fail" = 0 ]; then echo "✔ secret scan: no findings in $(git ls-files | wc -l | tr -d ' ') tracked files"; fi
exit "$fail"
