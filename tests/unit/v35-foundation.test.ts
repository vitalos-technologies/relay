// V3.5 foundation (pure): webhook verifiers, SLA business-time maths, Facebook inbox parsing + reply rules,
// sync backoff, workload classes, permissions.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PRESET_PERMISSIONS } from '@social-lite/core';
import { addBusinessMs, businessMsBetween, dueAt, elapsedBusinessMinutes } from '@social-lite/core/contracts/v35-sla';
import { syncBackoffMs, SYNC_RETRY } from '@social-lite/core/contracts/v35-connectors';
import { parseFacebookWebhook, facebookReplyRules } from '@social-lite/providers/meta/inbox';
import { verifyAsana, verifyHubspotV3, verifyMetaSha256, verifyMonday, verifySlack } from '@social-lite/services/connectors/verify';
import { workloadPolicies, QUEUE_CLASS } from '@social-lite/services/workload/policy';

const now = new Date('2026-11-07T12:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));
const req = (rawBody: string, headers: Record<string, string>, extra: Partial<{ method: string; uri: string }> = {}) => ({ rawBody, headers, method: extra.method ?? 'POST', uri: extra.uri ?? 'https://relay.test/api/connectors/webhooks/x', now });

describe('webhook verifiers', () => {
  it('Slack: valid signature accepted; tampered, stale and unconfigured refused; url_verification answered', () => {
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev1', team_id: 'T1', event: { type: 'app_mention' } });
    const sig = `v0=${createHmac('sha256', 'slack-secret').update(`v0:${ts}:${body}`).digest('hex')}`;
    const ok = verifySlack(req(body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig, 'content-type': 'application/json' }), 'slack-secret');
    expect(ok).toMatchObject({ ok: true, kind: 'event', dedupeKey: 'Ev1', externalAccountId: 'T1' });
    expect(verifySlack(req(body + ' ', { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }), 'slack-secret')).toEqual({ ok: false, reason: 'bad_signature' });
    const old = String(Number(ts) - 600);
    expect(verifySlack(req(body, { 'x-slack-request-timestamp': old, 'x-slack-signature': sig }), 'slack-secret')).toEqual({ ok: false, reason: 'stale' });
    expect(verifySlack(req(body, {}), null)).toEqual({ ok: false, reason: 'not_configured' });
    // rotation: previous secret still verifies
    expect(verifySlack(req(body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig, 'content-type': 'application/json' }), 'new-secret', 'slack-secret').ok).toBe(true);
    const ch = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const chSig = `v0=${createHmac('sha256', 's').update(`v0:${ts}:${ch}`).digest('hex')}`;
    expect(verifySlack(req(ch, { 'x-slack-request-timestamp': ts, 'x-slack-signature': chSig }), 's')).toMatchObject({ ok: true, kind: 'handshake', response: { body: 'abc' } });
  });

  it('HubSpot v3: method + uri + body + timestamp, base64; dedupe by event ids', () => {
    const body = JSON.stringify([{ eventId: 2, portalId: 99, subscriptionType: 'ticket.propertyChange', occurredAt: now.getTime() }, { eventId: 1, portalId: 99 }]);
    const uri = 'https://relay.test/api/connectors/webhooks/hubspot';
    const sig = createHmac('sha256', 'hs').update(`POST${uri}${body}${ts}`).digest('base64');
    const r = verifyHubspotV3(req(body, { 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': ts }, { uri }), 'hs');
    expect(r).toMatchObject({ ok: true, dedupeKey: 'events:1,2', externalAccountId: '99' });
    expect(verifyHubspotV3(req(body, { 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': ts }, { uri: `${uri}?x=1` }), 'hs').ok).toBe(false);
  });

  it('Asana: handshake echoes the secret; events need the stored secret', () => {
    expect(verifyAsana(req('', { 'x-hook-secret': 'a'.repeat(32) }), null)).toMatchObject({ ok: true, kind: 'handshake', response: { headers: { 'x-hook-secret': 'a'.repeat(32) } } });
    const body = JSON.stringify({ events: [{ action: 'changed', resource: { gid: '1' } }] });
    const sig = createHmac('sha256', 'hook').update(body).digest('hex');
    expect(verifyAsana(req(body, { 'x-hook-signature': sig }), 'hook')).toMatchObject({ ok: true, kind: 'event', eventType: 'changed' });
    expect(verifyAsana(req(body, { 'x-hook-signature': sig }), null)).toEqual({ ok: false, reason: 'not_configured' });
    expect(verifyAsana(req(body, { 'x-hook-signature': 'deadbeef' }), 'hook')).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('Meta/WhatsApp X-Hub-Signature-256 and monday JWT', () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W1' }] });
    const sig = `sha256=${createHmac('sha256', 'app').update(body).digest('hex')}`;
    expect(verifyMetaSha256(req(body, { 'x-hub-signature-256': sig }), 'app')).toMatchObject({ ok: true, externalAccountId: 'W1' });
    expect(verifyMetaSha256(req(body, { 'x-hub-signature-256': sig }), 'other').ok).toBe(false);
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ accountId: 7, exp: Math.floor(now.getTime() / 1000) + 60 })).toString('base64url');
    const s = createHmac('sha256', 'mon').update(`${h}.${p}`).digest('base64url');
    const mb = JSON.stringify({ event: { type: 'update_column_value', triggerUuid: 'u1' } });
    expect(verifyMonday(req(mb, { authorization: `${h}.${p}.${s}` }), 'mon')).toMatchObject({ ok: true, dedupeKey: 'trigger:u1', externalAccountId: '7' });
    expect(verifyMonday(req(mb, { authorization: `${h}.${p}.x${s}` }), 'mon').ok).toBe(false);
    expect(verifyMonday(req(JSON.stringify({ challenge: 'c1' }), {}), null)).toMatchObject({ ok: true, kind: 'handshake' });
  });
});

describe('SLA business time', () => {
  const office = { timezone: 'Europe/London', business_hours: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })), holidays: ['2026-12-25'] };
  it('24/7 when no hours are set', () => {
    expect(businessMsBetween(new Date('2026-11-07T10:00:00Z'), new Date('2026-11-07T12:00:00Z'), { timezone: 'UTC', business_hours: null, holidays: [] })).toBe(2 * 3600_000);
  });
  it('counts only office hours; weekends and holidays are excluded', () => {
    // Fri 16:00 → Mon 10:00 London (winter, UTC+0) = 1 h Friday + 1 h Monday
    expect(businessMsBetween(new Date('2026-11-06T16:00:00Z'), new Date('2026-11-09T10:00:00Z'), office)).toBe(2 * 3600_000);
    // Christmas Day (Friday) is a holiday
    expect(businessMsBetween(new Date('2026-12-25T09:00:00Z'), new Date('2026-12-25T17:00:00Z'), office)).toBe(0);
  });
  it('due date skips the weekend and honours pauses', () => {
    const due = addBusinessMs(new Date('2026-11-06T16:30:00Z'), 60 * 60_000, office); // 30 min Fri + 30 min Mon
    expect(due?.toISOString()).toBe('2026-11-09T09:30:00.000Z');
    const clock = { start: new Date('2026-11-09T09:00:00Z'), pausedBusinessMs: 30 * 60_000, pausedSince: null };
    expect(dueAt(clock, 60, office)?.toISOString()).toBe('2026-11-09T10:30:00.000Z');
    expect(dueAt({ ...clock, pausedSince: new Date() }, 60, office)).toBeNull();
    expect(elapsedBusinessMinutes(clock, new Date('2026-11-09T11:00:00Z'), office)).toBe(90);
  });
  it('handles a DST change (London, last Sunday of March)', () => {
    const tz = { timezone: 'Europe/London', business_hours: [{ day: 1, start: '09:00', end: '17:00' }], holidays: [] };
    // Monday 30 March 2026 is in BST (UTC+1): 09:00 local = 08:00Z
    expect(addBusinessMs(new Date('2026-03-28T00:00:00Z'), 60_000, tz)?.toISOString()).toBe('2026-03-30T08:01:00.000Z');
  });
});

describe('Facebook inbox adapter (pure)', () => {
  it('parses messages, echoes, edits, comments, removals and receipts', () => {
    const items = parseFacebookWebhook({
      object: 'page', entry: [{
        id: 'P1', time: 1, messaging: [
          { sender: { id: 'U1' }, recipient: { id: 'P1' }, timestamp: 1_700_000_000_000, message: { mid: 'm1', text: 'Hi' } },
          { sender: { id: 'P1' }, recipient: { id: 'U1' }, timestamp: 1_700_000_001_000, message: { mid: 'm2', text: 'Hello', is_echo: true } },
          { sender: { id: 'U1' }, recipient: { id: 'P1' }, timestamp: 1_700_000_002_000, message_edit: { mid: 'm1', text: 'Hi!' } },
          { sender: { id: 'U1' }, recipient: { id: 'P1' }, read: { watermark: 1_700_000_003_000 } },
        ],
        changes: [
          { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', post_id: 'P1_9', parent_id: 'P1_9', message: 'Nice', from: { id: 'U2', name: 'Ana' }, created_time: 1_700_000_000 } },
          { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c2', post_id: 'P1_9', parent_id: 'c1', message: 'Thanks', from: { id: 'P1', name: 'Page' }, created_time: 1_700_000_100 } },
          { field: 'feed', value: { item: 'comment', verb: 'remove', comment_id: 'c1', post_id: 'P1_9', created_time: 1_700_000_200 } },
          { field: 'feed', value: { item: 'reaction', verb: 'add' } },
        ],
      }],
    });
    expect(items.map((i) => i.type)).toEqual(['message', 'message', 'edit', 'receipt', 'message', 'message', 'delete']);
    expect(items[0]).toMatchObject({ threadKey: 'psid:U1', direction: 'inbound', conversationKind: 'dm' });
    expect(items[1]).toMatchObject({ threadKey: 'psid:U1', direction: 'outbound' });
    expect(items[4]).toMatchObject({ threadKey: 'comment:c1', conversationKind: 'comment', author: { name: 'Ana' } });
    expect(items[5]).toMatchObject({ threadKey: 'comment:c1', direction: 'outbound', parentExternalId: 'c1' });
    expect(parseFacebookWebhook({ object: 'instagram', entry: [] })).toEqual([]);
  });

  it('enforces the 24 h window, Human Agent, and once-only private replies within 7 days', () => {
    const base = { now, firstInboundAt: null, privateReplyUsed: false, features: [] as string[] };
    expect(facebookReplyRules({ ...base, kind: 'dm', mode: 'private_message', lastInboundAt: new Date(now.getTime() - 3600_000) })).toMatchObject({ allowed: true });
    expect(facebookReplyRules({ ...base, kind: 'dm', mode: 'private_message', lastInboundAt: new Date(now.getTime() - 25 * 3600_000) })).toMatchObject({ allowed: false, code: 'reply_window_closed' });
    expect(facebookReplyRules({ ...base, features: ['human_agent'], kind: 'dm', mode: 'private_message', lastInboundAt: new Date(now.getTime() - 25 * 3600_000) })).toMatchObject({ allowed: true, tag: 'HUMAN_AGENT' });
    expect(facebookReplyRules({ ...base, kind: 'dm', mode: 'public_reply', lastInboundAt: now })).toMatchObject({ allowed: false, code: 'mode_not_supported' });
    expect(facebookReplyRules({ ...base, kind: 'comment', mode: 'public_reply', lastInboundAt: new Date(0) })).toMatchObject({ allowed: true });
    expect(facebookReplyRules({ ...base, kind: 'comment', mode: 'private_message', lastInboundAt: new Date(now.getTime() - 6 * 86_400_000) })).toMatchObject({ allowed: true });
    expect(facebookReplyRules({ ...base, kind: 'comment', mode: 'private_message', lastInboundAt: new Date(now.getTime() - 8 * 86_400_000) })).toMatchObject({ allowed: false });
    expect(facebookReplyRules({ ...base, privateReplyUsed: true, kind: 'comment', mode: 'private_message', lastInboundAt: now })).toMatchObject({ allowed: false, code: 'private_reply_used' });
  });
});

describe('V3.5 infrastructure policy', () => {
  it('sync backoff grows, honours Retry-After, and is capped', () => {
    expect(syncBackoffMs(1)).toBe(SYNC_RETRY.baseMs);
    expect(syncBackoffMs(3)).toBe(SYNC_RETRY.baseMs * 4);
    expect(syncBackoffMs(30)).toBe(SYNC_RETRY.maxMs);
    expect(syncBackoffMs(1, 120_000)).toBe(120_000);
  });
  it('customer replies run on the main pool, never deferred; bulk V3.5 classes defer on the bulk pool', () => {
    const p = workloadPolicies({});
    expect(p.customer_reply).toMatchObject({ pool: 'main', defers_under_publishing_pressure: false });
    expect(p.integration_sync).toMatchObject({ pool: 'bulk', defers_under_publishing_pressure: true });
    expect(p.listening_ingest).toMatchObject({ pool: 'bulk', defers_under_publishing_pressure: true, max_concurrent: 1 });
    expect(QUEUE_CLASS['inbox-reply']).toBe('customer_reply');
  });
  it('inbox permissions: care agents answer, viewers do not see private conversations', () => {
    expect(PRESET_PERMISSIONS.care_agent).toEqual(expect.arrayContaining(['inbox.read', 'inbox.reply', 'inbox.assign', 'cases.manage']));
    expect(PRESET_PERMISSIONS.care_agent).not.toContain('content.publish');
    expect(PRESET_PERMISSIONS.viewer).not.toContain('inbox.read');
    expect(PRESET_PERMISSIONS.editor).not.toContain('inbox.reply');
  });
});
