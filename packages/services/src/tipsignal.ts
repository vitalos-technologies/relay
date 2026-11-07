// TipSignal source integration (V1.1, optional). Signed, timestamped, schema-versioned events create
// DRAFTS (never posts) for the single configured brand. Exact facts (teams, kick-off, market, probability,
// result) come only from validated input; copy and graphics are deterministic templates — no AI, no
// image generation. Deduplicated on event_id so retries never create duplicate drafts.
import { createHmac, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError, formatInZone, zoneAbbreviation } from '@social-lite/core';
import { getPool, maybeOne } from '@social-lite/db';
import type { Ctx } from './context.js';
import { getSetting } from './settings.js';
import { loadAccess } from './tenancy.js';
import { createPost } from './posts/service.js';
import { completeUpload, createUploadIntent } from './media/index.js';
import { putObject } from './storage.js';
import { brandConnections } from './posts/shared.js';
import { audit } from './audit.js';

const MAX_SKEW_S = 300;

const fixture = z.object({
  home: z.string().trim().min(1).max(60), away: z.string().trim().min(1).max(60),
  competition: z.string().trim().min(1).max(60), kickoff_at: z.string().datetime({ offset: true }),
});
const common = { record_id: z.string().min(1).max(100), source_url: z.string().url().startsWith('https://').max(500), fixture, market: z.string().trim().min(1).max(60), selection: z.string().trim().min(1).max(60) };

export const tipsignalEventSchema = z.discriminatedUnion('type', [
  z.object({ schema_version: z.literal(1), event_id: z.string().min(8).max(100), type: z.literal('picks.ready'), occurred_at: z.string().datetime({ offset: true }),
    data: z.object({ ...common, probability: z.number().gt(0).lt(1) }).strict() }).strict(),
  z.object({ schema_version: z.literal(1), event_id: z.string().min(8).max(100), type: z.literal('results.settled'), occurred_at: z.string().datetime({ offset: true }),
    data: z.object({ ...common, settled: z.literal(true), settled_at: z.string().datetime({ offset: true }), result: z.enum(['won', 'lost', 'void']),
      final_score: z.string().regex(/^\d{1,2}-\d{1,2}$/) }).strict() }).strict(),
]);
export type TipsignalEvent = z.infer<typeof tipsignalEventSchema>;

/** Header: X-TipSignal-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)> */
export function signTipsignal(secret: string, raw: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}

function verify(secret: string, raw: string, header: string | null, now: number): void {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) throw new AppError('forbidden', 'Missing or malformed signature');
  const t = Number(m[1]);
  if (Math.abs(now / 1000 - t) > MAX_SKEW_S) throw new AppError('forbidden', 'Signature timestamp outside the allowed window');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'));
  const got = Buffer.from(m[2]!);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new AppError('forbidden', 'Invalid signature');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const pct = (p: number) => `${(Math.round(p * 1000) / 10).toFixed(1)}%`;

/** Deterministic copy. Probability is shown as a model estimate, never a promise. */
export function draftText(e: TipsignalEvent, tz: string): string {
  const f = e.data.fixture;
  const ko = new Date(f.kickoff_at);
  const when = `${formatInZone(ko, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} ${zoneAbbreviation(ko, tz)}`;
  if (e.type === 'picks.ready') {
    return `${f.competition}: ${f.home} v ${f.away}\nKick-off ${when}\n\nPick: ${e.data.selection} (${e.data.market})\nModel probability: ${pct(e.data.probability)}. Probabilities are estimates, not promises.\n\n${e.data.source_url}`;
  }
  const verdict = e.data.result === 'won' ? 'Won' : e.data.result === 'lost' ? 'Lost' : 'Void';
  return `Result — ${f.competition}: ${f.home} ${e.data.final_score} ${f.away}\n\nPick: ${e.data.selection} (${e.data.market}) — ${verdict}\n\n${e.data.source_url}`;
}

/** Deterministic 1080×1350 result/pick card: exact numbers from validated input; no generative imagery. */
export async function renderCard(e: TipsignalEvent, tz: string): Promise<Buffer> {
  const f = e.data.fixture;
  const ko = new Date(f.kickoff_at);
  const headline = e.type === 'picks.ready' ? 'PICK' : 'RESULT';
  const big = e.type === 'picks.ready' ? pct(e.data.probability) : e.data.final_score;
  const sub = e.type === 'picks.ready' ? 'model probability · not a promise' : (e.data.result === 'won' ? 'pick won' : e.data.result === 'lost' ? 'pick lost' : 'void');
  const accent = e.type === 'results.settled' && e.data.result === 'lost' ? '#FF8A7A' : '#C8F25A';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
  <rect width="1080" height="1350" fill="#0D0E10"/>
  <rect x="72" y="72" width="936" height="1206" rx="36" fill="#15171A" stroke="#2A2E34" stroke-width="2"/>
  <text x="132" y="190" font-family="Helvetica, Arial, sans-serif" font-size="34" letter-spacing="6" fill="${accent}">${headline}</text>
  <text x="132" y="250" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="#9AA1A9">${esc(f.competition)}</text>
  <text x="132" y="430" font-family="Helvetica, Arial, sans-serif" font-size="76" font-weight="700" fill="#EDEEF0">${esc(f.home)}</text>
  <text x="132" y="520" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="#9AA1A9">v</text>
  <text x="132" y="610" font-family="Helvetica, Arial, sans-serif" font-size="76" font-weight="700" fill="#EDEEF0">${esc(f.away)}</text>
  <text x="132" y="880" font-family="Helvetica, Arial, sans-serif" font-size="180" font-weight="700" fill="${accent}">${esc(big)}</text>
  <text x="132" y="950" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#9AA1A9">${esc(sub)}</text>
  <text x="132" y="1080" font-family="Helvetica, Arial, sans-serif" font-size="38" fill="#EDEEF0">${esc(e.data.selection)} · ${esc(e.data.market)}</text>
  <text x="132" y="1180" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#9AA1A9">${esc(formatInZone(ko, tz, { dateStyle: 'medium', timeStyle: 'short' }))} ${esc(zoneAbbreviation(ko, tz))}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function receiveTipsignal(raw: string, signature: string | null, now = Date.now()) {
  const secret = await getSetting('TIPSIGNAL_SIGNING_SECRET');
  if (!secret) throw new AppError('provider_not_configured', 'TipSignal integration is not configured');
  if (raw.length > 64 * 1024) throw new AppError('payload_too_large', 'Event too large');
  verify(secret, raw, signature, now);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new AppError('validation_failed', 'Body must be JSON'); }
  const parsed = tipsignalEventSchema.safeParse(json);
  if (!parsed.success) throw new AppError('validation_failed', 'Event does not match schema v1 (destination overrides and unknown fields are rejected)');
  const e = parsed.data;
  const db = getPool();
  const binding = await maybeOne<{ workspace_id: string; brand_id: string; acting_user_id: string; timezone: string }>(db,
    `SELECT ib.workspace_id, ib.brand_id, ib.acting_user_id, b.timezone FROM integration_bindings ib JOIN brands b ON b.id=ib.brand_id WHERE ib.kind='tipsignal'`);
  if (!binding) throw new AppError('provider_not_configured', 'No brand is bound to TipSignal');

  // Dedupe first: a retried event returns the original outcome.
  const ins = await maybeOne<{ id: string }>(db,
    `INSERT INTO source_events(source, source_event_id, event_type, schema_version, workspace_id, brand_id, payload)
     VALUES ('tipsignal',$1,$2,$3,$4,$5,$6) ON CONFLICT (source, source_event_id) DO NOTHING RETURNING id`,
    [e.event_id, e.type, e.schema_version, binding.workspace_id, binding.brand_id, JSON.stringify(e)]);
  if (!ins) {
    const prior = await maybeOne<{ status: string; post_id: string | null; reason: string | null }>(db, `SELECT status, post_id, reason FROM source_events WHERE source='tipsignal' AND source_event_id=$1`, [e.event_id]);
    return { status: 200, body: { duplicate: true, ...prior } };
  }
  const reject = async (reason: string) => {
    await db.query(`UPDATE source_events SET status='rejected', reason=$2 WHERE id=$1`, [ins.id, reason]);
    return { status: 422, body: { status: 'rejected', reason } };
  };
  if (e.type === 'picks.ready' && new Date(e.data.fixture.kickoff_at).getTime() <= now) return reject('Kick-off has passed; picks expire before kick-off.');
  if (e.type === 'results.settled' && new Date(e.data.settled_at).getTime() > now) return reject('Settlement time is in the future; results need verified settlement.');

  const access = await loadAccess(binding.acting_user_id, binding.workspace_id);
  if (!access) return reject('The configured acting member no longer has access.');
  const ctx: Ctx = { actor: { userId: binding.acting_user_id, email: 'tipsignal-integration', name: 'TipSignal', sessionId: 'integration' }, access: { ...access, brandIds: null }, correlationId: `tipsignal:${e.event_id}` };
  // Graphic through the normal media pipeline (validation + derivatives), then a draft for every ready destination.
  const png = await renderCard(e, binding.timezone);
  const intent = await createUploadIntent(ctx, { brand_id: binding.brand_id, filename: `tipsignal-${e.data.record_id}.png`, content_type: 'image/png', bytes: png.length });
  await putObject(intent.upload.fields.key!, png, 'image/png');
  const asset = await completeUpload(ctx, intent.asset_id);
  const conns = (await brandConnections(db, binding.workspace_id, binding.brand_id)).filter((c) => ['ready', 'expiring'].includes(c.status));
  const post = await createPost(ctx, binding.brand_id, {
    title: `${e.type === 'picks.ready' ? 'Pick' : 'Result'}: ${e.data.fixture.home} v ${e.data.fixture.away}`,
    draft: { baseText: draftText(e, binding.timezone), baseLink: null, baseAssetIds: asset.status === 'ready' ? [asset.id] : [],
      variants: conns.map((c) => ({ connectionId: c.id, inheritText: true, inheritMedia: true })) },
  }, `tipsignal-${e.event_id}`);
  await db.query(`UPDATE posts SET source=$2, tags=$3 WHERE id=$1`, [post.id, JSON.stringify({ kind: 'tipsignal', event_id: e.event_id, record_id: e.data.record_id, source_url: e.data.source_url, type: e.type }), ['tipsignal', e.type]]);
  await db.query(`UPDATE source_events SET status='draft_created', post_id=$2 WHERE id=$1`, [ins.id, post.id]);
  await audit(db, { workspaceId: binding.workspace_id, brandId: binding.brand_id, actorService: 'tipsignal', action: 'source_event.draft_created', resourceType: 'post', resourceId: post.id, diff: { event_id: e.event_id, type: e.type } });
  return { status: 201, body: { status: 'draft_created', post_id: post.id } };
}
