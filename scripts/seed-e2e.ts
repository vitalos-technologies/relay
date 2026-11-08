// Ensure the Playwright workspace exists (SYNTHETIC, local/test only): "E2E Workspace" with the same demo users, brands,
// simulated destinations and sample media as Demo Workspace, so E2E fixtures never land in the demo workspace (V3 §2.7).
// Idempotent: does nothing when it already exists. Run: pnpm db:seed:e2e (Playwright's global setup runs it too).
import { closePool, getPool, maybeOne } from '@social-lite/db';
import { grantOperatorCli } from './platform-operator.js';
import { config } from '@social-lite/services';
import { ensureBucket } from '@social-lite/services/storage';
import { seedAgency } from './seed-agency.js';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed E2E data in production');
if (!cfg.ENABLE_MOCK_PROVIDERS) throw new Error('E2E seeding needs ENABLE_MOCK_PROVIDERS=true (simulated destinations)');

async function main() {
  const db = getPool();
  const demo = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='Demo Workspace' AND is_demo`);
  if (!demo) throw new Error('Demo Workspace not found: run pnpm db:seed first (sign-in must default to it)');
  await ensureOnboardingWorkspace();
  // V4 billing (BIL): fresh no-card trial workspaces for tests/e2e/v4-billing.spec.ts (desktop and mobile runs).
  for (const name of ['E2E Billing', 'E2E Billing Mobile']) await ensureBillingWorkspace(name);
  // V3.1 Admin: the demo owner is also a platform operator in development/E2E (never in production seeds).
  const op = await maybeOne<{ ok: boolean }>(db, `SELECT to_regclass('public.platform_operators') IS NOT NULL AS ok`);
  if (op?.ok && !(await maybeOne(db, `SELECT 1 FROM platform_operators o JOIN users u ON u.id=o.user_id WHERE u.email='owner@demo.social-lite.test' AND o.revoked_at IS NULL`))) {
    await grantOperatorCli('owner@demo.social-lite.test', 'operator', 'seed');
  }
  const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='E2E Workspace' AND is_demo`);
  if (existing) { console.log(JSON.stringify({ msg: 'E2E workspace already present', workspaceId: existing.id })); return; }
  await ensureBucket();
  const r = await seedAgency('E2E Workspace', { tipsignalBinding: false });
  console.log(JSON.stringify({ msg: 'E2E workspace seeded', workspaceId: r.wsId }));
}

/**
 * V3.1 §7: "E2E Onboarding" — a new, empty synthetic workspace (one brand, nothing connected, no posts) owned by the
 * demo owner, for the onboarding checklist test and screenshots. Created after Demo Workspace, so sign-in still
 * defaults to Demo. Idempotent.
 */
async function ensureOnboardingWorkspace() {
  const db = getPool();
  const have = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name='E2E Onboarding' AND is_demo`);
  if (have) return;
  const owner = await maybeOne<{ id: string }>(db, `SELECT id FROM users WHERE email='owner@demo.social-lite.test'`);
  if (!owner) throw new Error('owner@demo.social-lite.test not found: run pnpm db:seed first');
  const ws = await maybeOne<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo) VALUES ('E2E Onboarding', true) RETURNING id`);
  await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws!.id, owner.id]);
  await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, granted_by, source)
    VALUES ($1,'user',$2,'owner','workspace',$2,'seed')`, [ws!.id, owner.id]);
  await db.query(`INSERT INTO brands(workspace_id, name, is_demo) VALUES ($1,'Northwind Bakery (demo)',true)`, [ws!.id]);
  console.log(JSON.stringify({ msg: 'E2E onboarding workspace seeded', workspaceId: ws!.id }));
}

/**
 * V4 billing: a workspace owned by the demo owner, reset on every seed to a fresh 14-day no-card Standard trial with no
 * provider records (test double objects from earlier runs are left behind and simply unreferenced). The trial redemption
 * row is permanent by design, so the reset only moves its end forward — exactly what a staff extension may do.
 */
async function ensureBillingWorkspace(name: string) {
  const db = getPool();
  if (!(await maybeOne<{ ok: boolean }>(db, `SELECT to_regclass('public.workspace_billing') IS NOT NULL AS ok`))?.ok) return;
  const owner = await maybeOne<{ id: string }>(db, `SELECT id FROM users WHERE email='owner@demo.social-lite.test'`);
  if (!owner) throw new Error('owner@demo.social-lite.test not found: run pnpm db:seed first');
  let ws = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name=$1 AND is_demo`, [name]);
  if (!ws) {
    ws = await maybeOne<{ id: string }>(db, `INSERT INTO workspaces(name, is_demo) VALUES ($1, true) RETURNING id`, [name]);
    await db.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws!.id, owner.id]);
    await db.query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, granted_by, source) VALUES ($1,'user',$2,'owner','workspace',$2,'seed')`, [ws!.id, owner.id]);
    await db.query(`INSERT INTO brands(workspace_id, name, is_demo) VALUES ($1,'Billing Bakery (demo)',true)`, [ws!.id]);
  }
  const id = ws!.id;
  const std = await maybeOne<{ id: string }>(db, `SELECT id FROM billing_plan_versions WHERE plan_id='standard' AND retired_at IS NULL`);
  await db.query(`UPDATE workspaces SET state='active', suspended_at=NULL, suspended_by=NULL, suspended_reason=NULL WHERE id=$1`, [id]);
  await db.query(`UPDATE billing_checkout_sessions SET status='cancelled' WHERE workspace_id=$1 AND status IN ('pending','open')`, [id]);
  await db.query(`DELETE FROM billing_invoices WHERE workspace_id=$1`, [id]);
  await db.query(`UPDATE billing_scheduled_actions SET status='cancelled' WHERE workspace_id=$1 AND status='scheduled'`, [id]);
  await db.query(`INSERT INTO billing_trial_redemptions(workspace_id, plan_id, plan_version_id, redeemed_by, source, started_at, ends_at, original_ends_at)
                  VALUES ($1,'standard',$2,$3,'signup',date_trunc('second', now()),date_trunc('second', now()) + interval '14 days',date_trunc('second', now()) + interval '14 days')
                  ON CONFLICT (workspace_id) DO UPDATE SET ends_at=greatest(billing_trial_redemptions.ends_at, EXCLUDED.ends_at)`, [id, std!.id, owner.id]);
  const red = await maybeOne<{ started_at: Date; ends_at: Date }>(db, `SELECT started_at, ends_at FROM billing_trial_redemptions WHERE workspace_id=$1`, [id]);
  await db.query(`INSERT INTO workspace_billing(workspace_id, plan_id, plan_version_id, status, seats) VALUES ($1,'standard',$2,'trialing',1) ON CONFLICT (workspace_id) DO NOTHING`, [id, std!.id]);
  await db.query(`UPDATE workspace_billing SET plan_id='standard', plan_version_id=$2, status='trialing', seats=1, provider=NULL, livemode=NULL, provider_customer_ref=NULL,
      provider_subscription_ref=NULL, provider_item_ref=NULL, provider_price_ref=NULL, provider_status=NULL, trial_started_at=$3, trial_ends_at=$4, trial_plan_id='standard',
      current_period_start=NULL, current_period_end=NULL, cancel_at_period_end=false, cancel_at=NULL, cancelled_at=NULL, ended_at=NULL, scheduled_plan_version_id=NULL,
      scheduled_seats=NULL, scheduled_effective_at=NULL, past_due_since=NULL, grace_ends_at=NULL, payment_action_required=false, payment_method=NULL, provider_synced_at=NULL,
      access_level='full', access_reason=NULL, updated_at=now(), version=version+1 WHERE workspace_id=$1`, [id, std!.id, red!.started_at, red!.ends_at]);
  console.log(JSON.stringify({ msg: 'E2E billing workspace reset to a fresh trial', name, workspaceId: id }));
}

main().then(() => closePool()).catch(async (err) => { console.error(err); await closePool(); process.exit(1); });
