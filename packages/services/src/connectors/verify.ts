// Webhook authenticity verifiers (V3.5 §13 "validate provider webhook authenticity using its supported mechanism").
// Pure functions over the RAW body + headers; constant-time comparisons; replay windows where the provider signs a
// timestamp. Sources (checked 2026-11-07, docs/v3-5/CAPABILITY_MATRIX.md):
//  - Slack:   X-Slack-Signature = "v0=" + hex(HMAC-SHA256(signing secret, "v0:" + X-Slack-Request-Timestamp + ":" + body)), ≤ 5 min.
//  - HubSpot: X-HubSpot-Signature-v3 = base64(HMAC-SHA256(client secret, method + uri + body + X-HubSpot-Request-Timestamp)), ≤ 5 min.
//  - Asana:   handshake echoes X-Hook-Secret; events: X-Hook-Signature = hex(HMAC-SHA256(hook secret, body)).
//  - Meta / WhatsApp: X-Hub-Signature-256 = "sha256=" + hex(HMAC-SHA256(app secret, body)).
//  - monday.com app webhooks: Authorization = JWT (HS256) signed with the app signing secret; URL challenge echoed.
//  - Mailchimp: optional X-Mailchimp-Signature; otherwise a hard-to-guess secret in the callback URL (?key=).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_MAX_SKEW_MS, type InboundRequest, type VerifyResult } from '@social-lite/core/contracts/v35-connectors';

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const hmacHex = (secret: string, data: string) => createHmac('sha256', secret).update(data, 'utf8').digest('hex');
const hmacB64 = (secret: string, data: string) => createHmac('sha256', secret).update(data, 'utf8').digest('base64');
export const digestOf = (raw: string) => createHash('sha256').update(raw).digest('hex');

function parseJson(raw: string): Record<string, unknown> | null {
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? (v as Record<string, unknown>) : null; } catch { return null; }
}

function fresh(tsSeconds: string | undefined, now: Date): boolean {
  if (!tsSeconds || !/^\d{9,13}$/.test(tsSeconds)) return false;
  const t = Number(tsSeconds);
  const ms = t > 1e12 ? t : t * 1000;
  return Math.abs(now.getTime() - ms) <= WEBHOOK_MAX_SKEW_MS;
}

const secrets = (s: string | null, prev?: string | null) => [s, prev].filter((x): x is string => !!x);

export function verifySlack(req: InboundRequest, secret: string | null, previous?: string | null): VerifyResult {
  const keys = secrets(secret, previous);
  if (!keys.length) return { ok: false, reason: 'not_configured' };
  const ts = req.headers['x-slack-request-timestamp'];
  if (!fresh(ts, req.now)) return { ok: false, reason: 'stale' };
  const sig = req.headers['x-slack-signature'] ?? '';
  if (!keys.some((k) => safeEqual(sig, `v0=${hmacHex(k, `v0:${ts}:${req.rawBody}`)}`))) return { ok: false, reason: 'bad_signature' };
  const ct = req.headers['content-type'] ?? '';
  let body: Record<string, unknown> | null = null;
  if (ct.includes('application/x-www-form-urlencoded')) {
    const p = new URLSearchParams(req.rawBody).get('payload');
    body = p ? parseJson(p) : null;
  } else body = parseJson(req.rawBody);
  if (!body) return { ok: false, reason: 'malformed' };
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return { ok: true, kind: 'handshake', response: { status: 200, headers: { 'content-type': 'text/plain' }, body: body.challenge.slice(0, 200) } };
  }
  const id = typeof body.event_id === 'string' ? body.event_id : typeof body.trigger_id === 'string' ? `trigger:${body.trigger_id}` : `digest:${digestOf(req.rawBody)}`;
  const team = (body.team_id ?? (body.team as { id?: string } | undefined)?.id ?? null) as string | null;
  const type = String((body.event as { type?: string } | undefined)?.type ?? body.type ?? 'unknown');
  return { ok: true, kind: 'event', dedupeKey: id, eventType: type.slice(0, 80), externalAccountId: team, occurredAt: null, summary: { type } };
}

export function verifyHubspotV3(req: InboundRequest, clientSecret: string | null, previous?: string | null): VerifyResult {
  const keys = secrets(clientSecret, previous);
  if (!keys.length) return { ok: false, reason: 'not_configured' };
  const ts = req.headers['x-hubspot-request-timestamp'];
  if (!fresh(ts, req.now)) return { ok: false, reason: 'stale' };
  const sig = req.headers['x-hubspot-signature-v3'] ?? '';
  // HubSpot decodes a fixed set of percent-encoded characters in the URI before signing.
  const uri = req.uri.replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%3F/gi, '?').replace(/%40/gi, '@').replace(/%21/gi, '!').replace(/%24/gi, '$')
    .replace(/%27/gi, "'").replace(/%28/gi, '(').replace(/%29/gi, ')').replace(/%2A/gi, '*').replace(/%2C/gi, ',').replace(/%3B/gi, ';');
  if (!keys.some((k) => safeEqual(sig, hmacB64(k, `${req.method.toUpperCase()}${uri}${req.rawBody}${ts}`)))) return { ok: false, reason: 'bad_signature' };
  let body: unknown;
  try { body = JSON.parse(req.rawBody || '[]'); } catch { return { ok: false, reason: 'malformed' }; }
  const events = Array.isArray(body) ? body as Array<{ eventId?: number | string; portalId?: number; subscriptionType?: string; occurredAt?: number }> : [];
  if (!events.length) return { ok: false, reason: 'malformed' };
  const ids = events.map((e) => String(e.eventId ?? '')).filter(Boolean).sort();
  return {
    ok: true, kind: 'event', dedupeKey: ids.length ? `events:${ids.join(',').slice(0, 400)}` : `digest:${digestOf(req.rawBody)}`,
    eventType: String(events[0]!.subscriptionType ?? 'unknown').slice(0, 80), externalAccountId: events[0]!.portalId ? String(events[0]!.portalId) : null,
    occurredAt: events[0]!.occurredAt ? new Date(events[0]!.occurredAt).toISOString() : null, summary: { count: events.length },
  };
}

/** Asana: first request is the handshake (X-Hook-Secret); `storeSecret` persists it encrypted before we echo it. */
export function verifyAsana(req: InboundRequest, hookSecret: string | null): VerifyResult {
  const handshake = req.headers['x-hook-secret'];
  if (handshake && !req.headers['x-hook-signature']) {
    if (!/^[A-Za-z0-9]{16,128}$/.test(handshake)) return { ok: false, reason: 'malformed' };
    return { ok: true, kind: 'handshake', response: { status: 200, headers: { 'x-hook-secret': handshake }, body: '' } };
  }
  if (!hookSecret) return { ok: false, reason: 'not_configured' };
  if (!safeEqual(req.headers['x-hook-signature'] ?? '', hmacHex(hookSecret, req.rawBody))) return { ok: false, reason: 'bad_signature' };
  const body = parseJson(req.rawBody);
  const events = Array.isArray(body?.events) ? body!.events as Array<{ resource?: { gid?: string }; action?: string; created_at?: string }> : null;
  if (!events) return { ok: false, reason: 'malformed' };
  // Heartbeats carry an empty array; dedupe by digest (Asana has no event id).
  return { ok: true, kind: 'event', dedupeKey: `digest:${digestOf(req.rawBody)}`, eventType: events.length ? String(events[0]!.action ?? 'changed') : 'heartbeat', externalAccountId: null, occurredAt: events[0]?.created_at ?? null, summary: { count: events.length } };
}

export function verifyMetaSha256(req: InboundRequest, appSecret: string | null, previous?: string | null): VerifyResult {
  const keys = secrets(appSecret, previous);
  if (!keys.length) return { ok: false, reason: 'not_configured' };
  const sig = req.headers['x-hub-signature-256'] ?? '';
  if (!keys.some((k) => safeEqual(sig, `sha256=${hmacHex(k, req.rawBody)}`))) return { ok: false, reason: 'bad_signature' };
  const body = parseJson(req.rawBody);
  if (!body || !Array.isArray(body.entry)) return { ok: false, reason: 'malformed' };
  const first = body.entry[0] as { id?: string; time?: number } | undefined;
  return { ok: true, kind: 'event', dedupeKey: `digest:${digestOf(req.rawBody)}`, eventType: String(body.object ?? 'unknown').slice(0, 80), externalAccountId: first?.id ? String(first.id) : null, occurredAt: null, summary: { entries: body.entry.length } };
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
}

/** monday.com: JWT (HS256) in Authorization signed with the app signing secret; challenge echoed (unsigned by design). */
export function verifyMonday(req: InboundRequest, signingSecret: string | null): VerifyResult {
  const body = parseJson(req.rawBody);
  if (!body) return { ok: false, reason: 'malformed' };
  if (typeof body.challenge === 'string' && !body.event) {
    return { ok: true, kind: 'handshake', response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: body.challenge.slice(0, 200) }) } };
  }
  if (!signingSecret) return { ok: false, reason: 'not_configured' };
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return { ok: false, reason: 'bad_signature' };
  const header = b64urlJson(h);
  if (header?.alg !== 'HS256') return { ok: false, reason: 'bad_signature' };
  const expected = createHmac('sha256', signingSecret).update(`${h}.${p}`).digest('base64url');
  if (!safeEqual(s, expected)) return { ok: false, reason: 'bad_signature' };
  const claims = b64urlJson(p);
  if (claims && typeof claims.exp === 'number' && claims.exp * 1000 < req.now.getTime()) return { ok: false, reason: 'stale' };
  const ev = (body.event ?? {}) as { type?: string; triggerUuid?: string; boardId?: number; pulseId?: number; triggerTime?: string };
  return { ok: true, kind: 'event', dedupeKey: ev.triggerUuid ? `trigger:${ev.triggerUuid}` : `digest:${digestOf(req.rawBody)}`, eventType: String(ev.type ?? 'unknown').slice(0, 80), externalAccountId: claims?.accountId ? String(claims.accountId) : null, occurredAt: ev.triggerTime ?? null, summary: { board: ev.boardId ?? null } };
}

/**
 * Mailchimp: X-Mailchimp-Signature when configured, else the per-installation URL key (?key=).
 * OPEN (stream C): the docs say the HMAC covers the timestamp and raw body; the exact join (assumed `ts.body` here) must be
 * confirmed against a real signed delivery before enabling signature mode. URL-key mode is the documented baseline.
 */
export function verifyMailchimp(req: InboundRequest, secret: string | null, urlKey: string | null, expectedUrlKey: string | null): VerifyResult {
  const sig = req.headers['x-mailchimp-signature'];
  if (sig && secret) {
    const ts = req.headers['x-mailchimp-request-timestamp'];
    if (!fresh(ts, req.now)) return { ok: false, reason: 'stale' };
    if (!safeEqual(sig, hmacHex(secret, `${ts}.${req.rawBody}`))) return { ok: false, reason: 'bad_signature' };
  } else {
    if (!expectedUrlKey) return { ok: false, reason: 'not_configured' };
    if (!urlKey || !safeEqual(urlKey, expectedUrlKey)) return { ok: false, reason: 'bad_signature' };
  }
  const form = new URLSearchParams(req.rawBody);
  const type = form.get('type') ?? 'unknown';
  return { ok: true, kind: 'event', dedupeKey: `digest:${digestOf(req.rawBody)}`, eventType: type.slice(0, 80), externalAccountId: form.get('data[list_id]'), occurredAt: form.get('fired_at'), summary: { type } };
}
