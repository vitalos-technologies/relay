// Playwright global setup: make sure the dedicated "E2E Workspace" exists (pnpm db:seed:e2e, idempotent) so test
// fixtures never land in Demo Workspace. Reads .env when present; set E2E_SKIP_SEED=1 to skip (e.g. a remote target).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function dotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export default function globalSetup() {
  if (process.env.E2E_SKIP_SEED === '1') return;
  execSync('pnpm -s db:seed:e2e', { stdio: 'inherit', env: { ...dotenv('.env'), ...process.env } });
}
