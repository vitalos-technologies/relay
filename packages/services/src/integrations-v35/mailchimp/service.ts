// Mailchimp (brief §9): draft campaigns from approved Relay content, links between social and email campaigns,
// campaign status + report. Relay never sends a campaign and never adds, updates or subscribes audience members:
// the client has no such calls (it refuses send/schedule/test/members paths). Sending happens in Mailchimp.
//  - "Approved content" = the text of a schedule that passed Relay's scheduling/approval services (active or completed);
//    the approval gate is re-run for that exact schedule before export.
//  - Webhooks: per-installation URL key (baseline) or X-Mailchimp-Signature (t=<ts>,v1=<hex HMAC-SHA256(secret,
//    "<ts>.<body>")>, ≤ 5 min) — format confirmed in Mailchimp's webhook guide on 2026-11-08.
import { createHmac, randomBytes } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import { WEBHOOK_MAX_SKEW_MS, type InboundRequest, type SyncOutcome, type VerifyResult } from '@social-lite/core/contracts/v35-connectors';
import type { MailchimpExportJson, OutboundPreviewJson } from '@social-lite/core/contracts/v35-integrations';
import { getPool, many, maybeOne } from '@social-lite/db';
import {
  MAILCHIMP_LOGIN_HOST, mailchimpAudiences, mailchimpAuthorizeUrl, mailchimpCampaignUrl, mailchimpCampaigns, mailchimpCreateDraft, mailchimpExchange, mailchimpFindByMarker,
  mailchimpGetCampaign, mailchimpMetadata, mailchimpPing, mailchimpReport,
} from '@social-lite/providers/mailchimp/client';
import { mailchimpSim } from '@social-lite/providers/mailchimp/sim';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { audit } from '../../audit.js';
import { encryptSecret, settingAad } from '../../crypto.js';
import { approvalGate } from '../../posts/approval-policy.js';
import { getSetting } from '../../settings.js';
import { brandAllowed } from '../../tenancy.js';
import { digestOf, safeEqual } from '../../connectors/verify.js';
import { enqueueSyncJob, loadIntegration, registerInboundHandler, registerSyncExecutor, registerVerifier, upsertExternalLink } from '../../connectors/index.js';
import { appErrorFrom, openConn, outcomeFromError, webhookUrlFor } from '../core/runtime.js';
import { loadRelayObject } from '../core/relay-objects.js';
import type { Conn, HubAdapter } from '../core/types.js';
import { withTx } from '@social-lite/db';

export const mailchimpAdapter: HubAdapter = {
  connector: 'mailchimp', hosts: [MAILCHIMP_LOGIN_HOST], sim: mailchimpSim, connect: 'oauth', webhook: 'per_installation',
  required: ['MAILCHIMP_CLIENT_ID', 'MAILCHIMP_CLIENT_SECRET'], optional: ['MAILCHIMP_WEBHOOK_SECRET'], simSettings: { dc: 'us1' },
  capabilities: ['Choose audiences explicitly', 'Create draft campaigns from approved posts (never sends)', 'Link social and email campaigns', 'Campaign status and results', 'Never subscribes anyone'],
  authorizeUrl: (cfg, p) => mailchimpAuthorizeUrl({ clientId: cfg.values.MAILCHIMP_CLIENT_ID!, redirectUri: cfg.redirectUri, state: p.state }),
  async exchange(t, cfg, p) {
    const tok = await mailchimpExchange(t, { clientId: cfg.values.MAILCHIMP_CLIENT_ID!, clientSecret: cfg.values.MAILCHIMP_CLIENT_SECRET!, redirectUri: cfg.redirectUri, code: p.code });
    const meta = await mailchimpMetadata(t, tok.accessToken);
    return { externalAccountId: meta.loginId, displayName: `Mailchimp · ${meta.accountName}`, grantedScopes: [], creds: { accessToken: tok.accessToken, refreshToken: null, expiresAt: null },
      settings: { dc: meta.dc }, health: { status: 'active', message: `Connected to ${meta.accountName} (account-wide access).` } };
  },
  async verify(c) { await mailchimpPing(mc(c)); return { status: 'active', message: 'Mailchimp API reachable.' }; },
  async discover(c, p) {
    if (p.type === 'campaign') return (await mailchimpCampaigns(mc(c))).map((x) => ({ resource_type: 'campaign', external_id: x.id, name: x.settings.title || x.settings.subject_line || x.id, url: mailchimpCampaignUrl(String(c.settings.dc), x.web_id), detail: x.status, selected: false }));
    return (await mailchimpAudiences(mc(c))).map((a) => ({ resource_type: 'audience', external_id: a.id, name: a.name, url: null, detail: a.stats?.member_count !== undefined ? `${a.stats.member_count} contacts` : null, selected: false }));
  },
};

const mc = (c: Conn) => ({ t: c.t, token: c.token, dc: String(c.settings.dc ?? '') });

// ------------------------------------------------------------------ webhook verification
export function verifyMailchimpWebhook(req: InboundRequest, secret: string | null, urlKey: string | null, expectedUrlKey: string | null): VerifyResult {
  const sig = req.headers['x-mailchimp-signature'];
  if (sig && secret) {
    const parts = Object.fromEntries(sig.split(',').map((kv) => kv.trim().split('=') as [string, string]));
    const ts = parts.t; const v1 = parts.v1;
    if (!ts || !v1 || !/^\d{9,11}$/.test(ts)) return { ok: false, reason: 'bad_signature' };
    if (Math.abs(req.now.getTime() - Number(ts) * 1000) > WEBHOOK_MAX_SKEW_MS) return { ok: false, reason: 'stale' };
    if (!safeEqual(v1, createHmac('sha256', secret).update(`${ts}.${req.rawBody}`, 'utf8').digest('hex'))) return { ok: false, reason: 'bad_signature' };
  } else {
    if (!expectedUrlKey) return { ok: false, reason: 'not_configured' };
    if (!urlKey || !safeEqual(urlKey, expectedUrlKey)) return { ok: false, reason: 'bad_signature' };
  }
  const form = new URLSearchParams(req.rawBody);
  const type = form.get('type') ?? 'unknown';
  return { ok: true, kind: 'event', dedupeKey: `digest:${digestOf(req.rawBody)}`, eventType: type.slice(0, 80), externalAccountId: form.get('data[list_id]'), occurredAt: form.get('fired_at'), summary: { type } };
}

/** Per-installation webhook URL (URL-key mode). Shown once; regenerating replaces the key. */
export async function issueMailchimpWebhookUrl(ctx: Ctx, integrationId: string): Promise<{ url: string }> {
  const integ = await loadIntegration(ctx, integrationId, 'integrations.manage');
  if (integ.connector !== 'mailchimp') throw new AppError('validation_failed', 'Choose a Mailchimp integration.');
  const key = randomBytes(24).toString('base64url');
  const blob = encryptSecret(key, settingAad(`integration:${integ.id}:webhook`));
  await getPool().query(`UPDATE integration_connections SET settings = settings || jsonb_build_object('webhook_secret_enc', $2::jsonb), updated_at=now() WHERE id=$1`, [integ.id, JSON.stringify(blob)]);
  await audit(getPool(), { workspaceId: integ.workspace_id, brandId: integ.brand_id, actorUserId: ctx.actor.userId, action: 'integration.webhook_key_issued', resourceType: 'integration', resourceId: integ.id, correlationId: ctx.correlationId });
  return { url: `${webhookUrlFor('mailchimp', integ.id)}&key=${key}` };
}

// ------------------------------------------------------------------ export (draft only)
export const exportSchema = z.object({
  integration_id: z.string().uuid(), post_id: z.string().uuid(), audience_resource_id: z.string().uuid(), subject: z.string().trim().min(1).max(150),
  preview_text: z.string().max(150).nullable().optional(), from_name: z.string().max(100).nullable().optional(), reply_to: z.string().email().max(200).nullable().optional(),
}).strict();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function exportRequest(ctx: Ctx, input: z.infer<typeof exportSchema>) {
  const post = await loadRelayObject(ctx, 'post', input.post_id, 'content.schedule');
  const integ = await loadIntegration(ctx, input.integration_id, 'integrations.read');
  if (integ.connector !== 'mailchimp') throw new AppError('validation_failed', 'Choose a Mailchimp integration.');
  if (integ.brand_id && integ.brand_id !== post.brandId) throw notFound('Integration');
  const aud = await maybeOne<{ external_id: string; name: string }>(getPool(), `SELECT external_id, name FROM integration_resources WHERE id=$1 AND integration_id=$2 AND resource_type='audience' AND selected AND access_state='ok'`, [input.audience_resource_id, integ.id]);
  if (!aud) throw new AppError('validation_failed', 'Choose an audience selected in Mailchimp settings.');
  const s = await maybeOne<{ id: string; base_text: string; base_link: string | null; status: string }>(getPool(),
    `SELECT s.id, r.base_text, r.base_link, s.status FROM schedules s JOIN post_revisions r ON r.id=s.revision_id WHERE s.post_id=$1 AND s.workspace_id=$2 AND s.status IN ('active','completed') ORDER BY s.generation DESC LIMIT 1`,
    [post.id, ctx.access.workspaceId]);
  if (!s) throw new AppError('invalid_state', 'Only approved, scheduled or published content can be exported. Schedule the post (and get it approved) first.');
  const gate = await approvalGate(getPool(), { workspace_id: ctx.access.workspaceId, brand_id: post.brandId, schedule_id: s.id });
  if (!gate.ok) throw new AppError('invalid_state', gate.message, undefined, { reason: gate.code });
  const paras = s.base_text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  const html = `${paras}${s.base_link ? `\n<p><a href="${esc(s.base_link)}">${esc(s.base_link)}</a></p>` : ''}`;
  return { post, integ, aud, schedule: s, html, text: s.base_text };
}

export async function previewMailchimpExport(ctx: Ctx, input: z.infer<typeof exportSchema>): Promise<OutboundPreviewJson> {
  const r = await exportRequest(ctx, input);
  return { connector: 'mailchimp', destination: `Mailchimp draft · audience ${r.aud.name}`, fields: [
    { label: 'Subject', value: input.subject }, ...(input.preview_text ? [{ label: 'Preview text', value: input.preview_text }] : []), { label: 'Body', value: r.text },
    { label: 'Status in Mailchimp', value: 'Draft — not sent. Review and send in Mailchimp.' },
  ], excluded: ['Nobody is subscribed or added to the audience', 'No email is sent', 'Media files'] };
}

/** One draft per post per Mailchimp account (repeat requests return the same job/link). Never sends. */
export async function exportToMailchimp(ctx: Ctx, input: z.infer<typeof exportSchema>) {
  const r = await exportRequest(ctx, input);
  const res = await enqueueSyncJob(ctx, { integrationId: r.integ.id, kind: 'mailchimp.campaign', relayType: 'post', relayId: r.post.id,
    payload: { list_id: r.aud.external_id, audience_name: r.aud.name, post_title: r.post.title, subject: input.subject, preview_text: input.preview_text ?? null, from_name: input.from_name ?? null, reply_to: input.reply_to ?? null, html: r.html, schedule_id: r.schedule.id } });
  return res;
}

async function runCampaign(job: { id: string; workspaceId: string; integrationId: string; payload: Record<string, unknown>; originMarker: string }): Promise<SyncOutcome> {
  const p = job.payload as { list_id: string; post_title: string; subject: string; preview_text: string | null; from_name: string | null; reply_to: string | null; html: string };
  let c: Conn;
  try { c = await openConn(job.integrationId); } catch (err) { return outcomeFromError(err, { integrationId: job.integrationId, workspaceId: job.workspaceId }, false); }
  try {
    // The internal title (never shown to recipients) carries the origin marker for reconciliation.
    const camp = await mailchimpCreateDraft(mc(c), { listId: p.list_id, title: `Relay · ${p.post_title} · ${job.originMarker}`.slice(0, 200), subject: p.subject, previewText: p.preview_text, fromName: p.from_name, replyTo: p.reply_to, html: p.html });
    return { kind: 'succeeded', externalId: camp.id, externalUrl: mailchimpCampaignUrl(String(c.settings.dc), camp.web_id), result: { status: camp.status } };
  } catch (err) { return outcomeFromError(err, c, true); }
}

async function reconcileCampaign(job: { integrationId: string; originMarker: string }) {
  const c = await openConn(job.integrationId);
  const camp = await mailchimpFindByMarker(mc(c), job.originMarker);
  return camp ? { found: true as const, externalId: camp.id, externalUrl: mailchimpCampaignUrl(String(c.settings.dc), camp.web_id) } : { found: false as const };
}

export async function mailchimpExportsForPost(ctx: Ctx, postId: string): Promise<{ items: MailchimpExportJson[] }> {
  await loadRelayObject(ctx, 'post', postId, 'content.read');
  const rows = await many<{ job_id: string; state: string; payload: { list_id: string; audience_name?: string }; created_at: Date; external_id: string | null; external_url: string | null; is_simulated: boolean; data: Record<string, unknown> | null; fetched_at: Date | null; brand_id: string | null }>(getPool(),
    `SELECT j.id AS job_id, j.state, j.payload, j.created_at, coalesce(l.external_id, j.external_id) AS external_id, coalesce(l.external_url, j.external_url) AS external_url, i.is_simulated, s.data, s.fetched_at, i.brand_id
       FROM integration_sync_jobs j JOIN integration_connections i ON i.id=j.integration_id
       LEFT JOIN external_links l ON l.integration_id=j.integration_id AND l.relay_type='post' AND l.relay_id=j.relay_id AND l.external_type='campaign' AND l.status <> 'unlinked'
       LEFT JOIN external_link_snapshots s ON s.link_id=l.id
      WHERE j.workspace_id=$1 AND j.kind='mailchimp.campaign' AND j.relay_id=$2 ORDER BY j.created_at DESC LIMIT 20`, [ctx.access.workspaceId, postId]);
  return { items: rows.filter((r) => !r.brand_id || brandAllowed(ctx, r.brand_id)).map((r) => ({
    job_id: r.job_id, state: r.state, post_id: postId, audience_id: r.payload.list_id, audience_name: r.payload.audience_name ?? null, campaign_id: r.external_id, campaign_url: r.external_url,
    status: (r.data?.status as string | undefined) ?? (r.external_id ? 'save' : null), report: (r.data?.report as MailchimpExportJson['report']) ?? null, fetched_at: r.fetched_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(), is_simulated: r.is_simulated,
  })) };
}

/** Explicit refresh of a linked campaign's status + report (stored; pages render from the snapshot). */
export async function refreshMailchimpCampaign(ctx: Ctx, postId: string) {
  await loadRelayObject(ctx, 'post', postId, 'content.read');
  const links = await many<{ id: string; integration_id: string; external_id: string }>(getPool(),
    `SELECT l.id, l.integration_id, l.external_id FROM external_links l JOIN integration_connections i ON i.id=l.integration_id WHERE l.workspace_id=$1 AND l.relay_type IN ('post','campaign') AND l.relay_id=$2 AND l.external_type='campaign' AND l.status='linked' AND i.connector='mailchimp'`,
    [ctx.access.workspaceId, postId]);
  for (const l of links) {
    await loadIntegration(ctx, l.integration_id, 'integrations.read');
    const c = await openConn(l.integration_id);
    try {
      const camp = await mailchimpGetCampaign(mc(c), l.external_id);
      const report = camp.status === 'save' ? null : await mailchimpReport(mc(c), l.external_id).catch(() => null);
      await getPool().query(`INSERT INTO external_link_snapshots(link_id, workspace_id, data) VALUES ($1,$2,$3) ON CONFLICT (link_id) DO UPDATE SET data=EXCLUDED.data, fetched_at=now(), fetch_error=NULL`,
        [l.id, ctx.access.workspaceId, JSON.stringify({ status: camp.status, report })]);
    } catch (err) {
      if ((err as { kind?: string }).kind === 'not_found') await getPool().query(`UPDATE external_links SET status='unavailable', status_detail='The campaign was deleted in Mailchimp.', updated_at=now() WHERE id=$1`, [l.id]);
      else throw await appErrorFrom(err, c);
    }
  }
  return mailchimpExportsForPost(ctx, postId);
}

export const linkCampaignSchema = z.object({ integration_id: z.string().uuid(), campaign_id: z.string().uuid(), mailchimp_campaign_id: z.string().min(1).max(40) }).strict();

/** Link a Relay campaign to an existing Mailchimp campaign (explicit, reversible). */
export async function linkMailchimpCampaign(ctx: Ctx, input: z.infer<typeof linkCampaignSchema>) {
  const camp = await loadRelayObject(ctx, 'campaign', input.campaign_id);
  const integ = await loadIntegration(ctx, input.integration_id, 'integrations.read');
  if (integ.connector !== 'mailchimp' || (integ.brand_id && integ.brand_id !== camp.brandId)) throw notFound('Integration');
  const c = await openConn(integ.id);
  let m;
  try { m = await mailchimpGetCampaign(mc(c), input.mailchimp_campaign_id); } catch (err) { throw await appErrorFrom(err, c); }
  return withTx(async (tx) => {
    const l = await upsertExternalLink(tx, { workspaceId: ctx.access.workspaceId, brandId: camp.brandId, integrationId: integ.id, relayType: 'campaign', relayId: camp.id, externalType: 'campaign', externalId: m.id,
      externalUrl: mailchimpCampaignUrl(String(c.settings.dc), m.web_id), actorUserId: ctx.actor.userId });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: camp.brandId, actorUserId: ctx.actor.userId, action: 'integration.campaign_linked', resourceType: 'campaign', resourceId: camp.id, diff: { mailchimp: m.id }, correlationId: ctx.correlationId });
    return { link_id: l.id, status: m.status };
  });
}

export function registerMailchimp(): void {
  registerSyncExecutor({ kind: 'mailchimp.campaign', run: runCampaign, reconcile: reconcileCampaign });
  registerVerifier('mailchimp', async (req, v) => verifyMailchimpWebhook(req, (await getSetting('MAILCHIMP_WEBHOOK_SECRET')) ?? null, v.query.get('key'), v.installationSecret));
  // Audience events (subscribe/unsubscribe/cleaned/profile) are acknowledged and recorded only: Relay holds no audience
  // copy, so suppression and unsubscribe states stay authoritative in Mailchimp.
  registerInboundHandler({ connector: 'mailchimp', async handle(e) { return { outcome: 'ignored', detail: `audience event ${e.eventType} recorded; Relay keeps no audience copy` }; } });
}
