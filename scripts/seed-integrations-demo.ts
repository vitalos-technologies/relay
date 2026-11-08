// SYNTHETIC business-integration demo data (local/dev only) for screenshots and manual QA. Every installation is
// SIMULATED (mock_ accounts, simulated provider APIs, labelled "Simulated"); nothing reaches Asana, monday.com, HubSpot,
// Google, Slack or Mailchimp.
//   set -a; . ./.env; set +a; npx tsx scripts/seed-integrations-demo.ts ["Demo Workspace"]
// Needs scripts/seed-inbox-demo.ts first (a case to hand over). Idempotent: skips when a simulated Asana install exists.
// Uses the real services (authorization, audit, outbox); sync jobs are run inline so the demo does not depend on a
// worker that already has the stream C executors.
import { randomUUID } from 'node:crypto';
import { closePool, getPool, many, maybeOne } from '@social-lite/db';
import { config, loadAccess, type Ctx } from '@social-lite/services';
import { runSyncJob, selectResources, setFieldMapping } from '@social-lite/services/connectors/index';
import {
  createExternalTask, createHubspotTicket, createSimulatedHubInstallation, discoverResources, enqueueSlackEvent, exportToMailchimp, pullTask, requestGbpLocalPosts,
  saveSlackRoute, sendSlackDeliveries, setHubspotDefaults, translate, updateTranslationSettings, refreshGbpMetrics, caseTicket, diagnoseIntegration,
} from '@social-lite/services/integrations-v35/index';
import { DbSimStore } from '@social-lite/services/integrations-v35/core/sim-store';
import { asanaSimExternalEdit } from '@social-lite/providers/asana/sim';

const cfg = config();
if (cfg.APP_ENV === 'production') throw new Error('Refusing to seed demo data in production');
const wsName = process.argv[2] ?? 'Demo Workspace';

async function ctxFor(email: string, workspaceId: string): Promise<Ctx> {
  const u = await maybeOne<{ id: string; name: string | null }>(getPool(), `SELECT id, name FROM users WHERE email=$1`, [email]);
  if (!u) throw new Error(`user ${email} not found`);
  const access = await loadAccess(u.id, workspaceId, getPool(), { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) throw new Error(`${email} has no access to ${wsName}`);
  return { actor: { userId: u.id, email, name: u.name, sessionId: randomUUID() }, access, correlationId: randomUUID() };
}

async function runJobs(integrationId: string) {
  for (const j of await many<{ id: string }>(getPool(), `SELECT id FROM integration_sync_jobs WHERE integration_id=$1 AND state='queued' ORDER BY created_at`, [integrationId])) await runSyncJob(j.id, 'demo-seed');
}

async function selectAll(ctx: Ctx, id: string, type: string, pick?: (name: string) => boolean) {
  const found = await discoverResources(ctx, id, { type });
  const items = found.items.filter((r) => !pick || pick(r.name));
  return (await selectResources(ctx, id, { resources: items.map((r) => ({ resource_type: r.resource_type, external_id: r.external_id, name: r.name, url: r.url, selected: true })) })).items.filter((r) => r.resource_type === type && r.selected);
}

async function main() {
  const db = getPool();
  const ws = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE name=$1 AND is_demo`, [wsName]);
  if (!ws) throw new Error(`${wsName} not found (synthetic demo workspaces only)`);
  if (await maybeOne(db, `SELECT 1 FROM integration_connections WHERE workspace_id=$1 AND connector='asana' AND is_simulated AND disconnected_at IS NULL`, [ws.id])) {
    console.log(JSON.stringify({ msg: 'integrations demo already seeded', workspace: wsName }));
    return;
  }
  const owner = await ctxFor('owner@demo.social-lite.test', ws.id);
  const brand = (await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND name LIKE 'Vitalos%' AND archived_at IS NULL LIMIT 1`, [ws.id]))!.id;
  const kase = await maybeOne<{ id: string }>(db, `SELECT id FROM care_cases WHERE workspace_id=$1 AND brand_id=$2 ORDER BY created_at LIMIT 1`, [ws.id, brand]);
  if (!kase) throw new Error('Run scripts/seed-inbox-demo.ts first');
  const store = new DbSimStore();

  // Asana: case → task, then a simulated teammate completes it in Asana (pulled, mapped two-way).
  const asana = await createSimulatedHubInstallation(owner, { connector: 'asana', brand_id: brand });
  const [proj] = await selectAll(owner, asana.id, 'project');
  await setFieldMapping(owner, asana.id, { relay_object: 'task', relay_field: 'status', external_field: 'completed', source_of_truth: 'relay', direction: 'two_way', conflict: 'manual_review', on_delete: 'mark_unavailable', on_revoke: 'mark_unavailable', enabled: true });
  const { task } = await createExternalTask(owner, { integration_id: asana.id, relay_type: 'case', relay_id: kase.id, resource_id: proj!.id, title: 'Confirm Saturday pickup for order 4417', due_on: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), priority: 'high' });
  await runJobs(asana.id);
  const ext = (await maybeOne<{ external_id: string }>(db, `SELECT external_id FROM integration_tasks WHERE id=$1`, [task.id]))!.external_id;
  const acct = (await maybeOne<{ external_account_id: string }>(db, `SELECT external_account_id FROM integration_connections WHERE id=$1`, [asana.id]))!.external_account_id;
  await asanaSimExternalEdit(store, acct, ext, { completed: true });
  await pullTask(task.id, 'poll');
  await diagnoseIntegration(owner, asana.id);

  // monday.com: board with mapped status/date columns; item from a post.
  const monday = await createSimulatedHubInstallation(owner, { connector: 'monday', brand_id: brand });
  const boards = await selectAll(owner, monday.id, 'board');
  const board = boards.find((b) => b.name === 'Campaign briefs')!;
  for (const [f, col] of [['status', 'status'], ['due_on', 'date4']] as const) {
    await setFieldMapping(owner, monday.id, { resource_id: board.id, relay_object: 'task', relay_field: f, external_field: col, source_of_truth: 'relay', direction: 'two_way', conflict: 'manual_review', on_delete: 'mark_unavailable', on_revoke: 'mark_unavailable', enabled: true });
  }
  const post = await maybeOne<{ id: string }>(db, `SELECT p.id FROM posts p WHERE p.workspace_id=$1 AND p.brand_id=$2 AND EXISTS (SELECT 1 FROM schedules s WHERE s.post_id=p.id AND s.status IN ('active','completed')) ORDER BY p.created_at DESC LIMIT 1`, [ws.id, brand]);

  // HubSpot: case → ticket (one per case).
  const hubspot = await createSimulatedHubInstallation(owner, { connector: 'hubspot', brand_id: brand });
  await selectAll(owner, hubspot.id, 'pipeline');
  await setHubspotDefaults(owner, hubspot.id, { default_pipeline: '0', default_stage: '1' });
  await createHubspotTicket(owner, { integration_id: hubspot.id, case_id: kase.id });
  await runJobs(hubspot.id);
  await caseTicket(owner, kase.id, true);

  // Google Business Profile: two locations selected, metrics, local post following a post's schedule.
  const gbp = await createSimulatedHubInstallation(owner, { connector: 'google_business_profile', brand_id: brand });
  const locs = await selectAll(owner, gbp.id, 'location', (n) => !n.includes('Market'));
  for (const l of locs) await refreshGbpMetrics(owner, l.id);

  // Google posts follow a post that is still scheduled (or awaiting approval).
  const upcoming = await maybeOne<{ id: string }>(db, `SELECT s.post_id AS id FROM schedules s WHERE s.workspace_id=$1 AND s.brand_id=$2 AND s.status IN ('active','pending_approval') AND s.due_at > now() ORDER BY s.due_at LIMIT 1`, [ws.id, brand]);
  if (upcoming) await requestGbpLocalPosts(owner, { post_id: upcoming.id, location_resource_ids: locs.map((l) => l.id), confirm_location_count: locs.length });

  // Mailchimp: audience + draft from a scheduled/published post.
  const mc = await createSimulatedHubInstallation(owner, { connector: 'mailchimp', brand_id: brand });
  const [aud] = await selectAll(owner, mc.id, 'audience', (n) => n.startsWith('Newsletter'));
  if (post) {
    await createExternalTask(owner, { integration_id: monday.id, relay_type: 'post', relay_id: post.id, resource_id: board.id, title: 'Brief: weekend specials', due_on: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) });
    await runJobs(monday.id);
    await exportToMailchimp(owner, { integration_id: mc.id, post_id: post.id, audience_resource_id: aud!.id, subject: 'This weekend at Vitalos Café' }).catch((e) => console.warn('mailchimp export skipped:', (e as Error).message));
    await runJobs(mc.id);
  }

  // Slack: approvals to a public channel, care escalations + assignments to a private one; one alert sent.
  const slack = await createSimulatedHubInstallation(owner, { connector: 'slack' });
  const chans = await selectAll(owner, slack.id, 'channel', (n) => n !== '#general');
  const pub = chans.find((c) => c.name === '#social-approvals')!; const priv = chans.find((c) => c.name === '#care-escalations')!;
  await saveSlackRoute(owner, { integration_id: slack.id, resource_id: pub.id, categories: ['approvals', 'delivery_alerts', 'connection_alerts', 'summaries'], brand_ids: null, quiet_start: '22:00', quiet_end: '07:00', timezone: 'Europe/London', max_per_hour: 20, summary_time: '08:30', enabled: true });
  await saveSlackRoute(owner, { integration_id: slack.id, resource_id: priv.id, categories: ['care_escalations', 'assignments'], brand_ids: [brand], quiet_start: null, quiet_end: null, timezone: 'Europe/London', max_per_hour: 30, summary_time: null, enabled: true });
  await enqueueSlackEvent({ workspaceId: ws.id, category: 'care_escalations', eventKey: `demo:case:${kase.id}:escalated`, brandId: brand, text: 'Case escalated', linkPath: `/inbox?case=${kase.id}` });
  await enqueueSlackEvent({ workspaceId: ws.id, category: 'delivery_alerts', eventKey: `demo:delivery:${randomUUID()}`, brandId: brand, text: 'A post failed to publish', linkPath: '/planner' });
  await getPool().query(`UPDATE slack_alert_routes SET quiet_start=NULL, quiet_end=NULL WHERE integration_id=$1`, [slack.id]);
  await sendSlackDeliveries();
  await getPool().query(`UPDATE slack_alert_routes SET quiet_start='22:00', quiet_end='07:00' WHERE integration_id=$1 AND resource_id=$2`, [slack.id, pub.id]);

  // Translation: workspace control on (simulated project), customer content allowed, one message translated.
  await createSimulatedHubInstallation(owner, { connector: 'google_translate' });
  await updateTranslationSettings(owner, { enabled: true, allow_customer_content: true, monthly_char_cap: 200_000, glossary_id: null, acknowledge_billing: true });
  const msg = await maybeOne<{ id: string }>(db, `SELECT m.id FROM inbox_messages m JOIN inbox_conversations c ON c.id=m.conversation_id WHERE c.workspace_id=$1 AND m.direction='inbound' AND m.body IS NOT NULL ORDER BY m.provider_created_at LIMIT 1`, [ws.id]);
  if (msg) await translate(owner, { source_type: 'inbox_message', source_id: msg.id, target_lang: 'es' });

  console.log(JSON.stringify({ msg: 'integrations demo seeded (simulated)', workspace: wsName, case: kase.id, post: post?.id ?? null }));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closePool());
