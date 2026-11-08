// V3.5 stream C — pure pieces of the business integrations: translation protection of links/mentions/placeholders,
// Mailchimp signature format (t=<ts>,v1=<hex>), task reference parsing, monday status labels, transport redaction,
// simulated-transport scenarios, Slack quiet hours.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { protectText, restoreText } from '@social-lite/providers/google-translate/client';
import { mondayLabelFor, mondayStatusFromLabel } from '@social-lite/providers/monday/client';
import { redactUrl, BizTransportError, classifyStatus } from '@social-lite/providers/biz/transport';
import { MemorySimStore, SimulatedBizTransport } from '@social-lite/providers/biz/sim';
import { asanaSim } from '@social-lite/providers/asana/sim';
import { mailchimpApiHost } from '@social-lite/providers/mailchimp/client';
import { hubspotOriginToken } from '@social-lite/providers/hubspot/client';
import { asanaTasks, mondayTasks } from '@social-lite/services/integrations-v35/work/providers';
import { verifyMailchimpWebhook } from '@social-lite/services/integrations-v35/mailchimp/service';
import { quietMinutesLeft } from '@social-lite/services/integrations-v35/slack/service';
import { CONNECTOR_SLUG, slugToConnector, HUB_CONNECTORS } from '@social-lite/core/contracts/v35-integrations';

describe('translation protection', () => {
  it('keeps links, mentions, hashtags, placeholders and brand terms byte-for-byte', () => {
    const src = 'Hi @cara_b! See https://ex.com/a?b=1&c=2 #AutumnMenu {{order}} %first_name% at Harbour Café <3';
    const { html, tokens } = protectText(src, ['Harbour Café']);
    expect(tokens).toEqual(['@cara_b', 'https://ex.com/a?b=1&c=2', '#AutumnMenu', '{{order}}', '%first_name%', 'Harbour Café']);
    expect(html).toContain('&lt;3');
    // A provider that rewrites text but keeps the spans: tokens are restored exactly.
    const translated = html.replace('Hi', 'Hola').replace(/<span translate="no" data-k="1">[^<]*<\/span>/, '<span translate="no" data-k="1">MANGLED</span>');
    const out = restoreText(translated, tokens);
    expect(out).toContain('https://ex.com/a?b=1&c=2');
    expect(out).toContain('@cara_b');
    expect(out.startsWith('Hola')).toBe(true);
    expect(out.endsWith('<3')).toBe(true);
  });
  it('round-trips multi-line text unchanged when nothing is translated', () => {
    const src = 'Line one\nLine two & more';
    const { html, tokens } = protectText(src);
    expect(restoreText(html, tokens)).toBe(src);
  });
});

describe('Mailchimp webhook verification', () => {
  const now = new Date();
  const body = 'type=unsubscribe&fired_at=2026-11-08+10%3A00%3A00&data%5Blist_id%5D=abc';
  const req = (headers: Record<string, string>) => ({ rawBody: body, headers, method: 'POST', uri: '/', now });
  it('signature mode: t=<ts>,v1=<hex HMAC(secret, ts.body)> within 5 minutes', () => {
    const ts = String(Math.floor(now.getTime() / 1000));
    const v1 = createHmac('sha256', 'sek').update(`${ts}.${body}`).digest('hex');
    expect(verifyMailchimpWebhook(req({ 'x-mailchimp-signature': `t=${ts},v1=${v1}` }), 'sek', null, null)).toMatchObject({ ok: true, eventType: 'unsubscribe', externalAccountId: 'abc' });
    expect(verifyMailchimpWebhook(req({ 'x-mailchimp-signature': `t=${ts},v1=${'0'.repeat(64)}` }), 'sek', null, null)).toMatchObject({ ok: false, reason: 'bad_signature' });
    const old = String(Math.floor(now.getTime() / 1000) - 600);
    expect(verifyMailchimpWebhook(req({ 'x-mailchimp-signature': `t=${old},v1=${createHmac('sha256', 'sek').update(`${old}.${body}`).digest('hex')}` }), 'sek', null, null)).toMatchObject({ ok: false, reason: 'stale' });
  });
  it('URL-key mode (baseline): missing key ⇒ not configured; wrong key ⇒ refused', () => {
    expect(verifyMailchimpWebhook(req({}), null, 'k', null)).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(verifyMailchimpWebhook(req({}), null, 'wrong', 'right')).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(verifyMailchimpWebhook(req({}), null, 'right', 'right')).toMatchObject({ ok: true });
  });
});

describe('task references + status labels', () => {
  it('parses Asana and monday links; rejects other hosts', () => {
    expect(asanaTasks.parseRef('https://app.asana.com/0/1201/1209876543210')).toBe('1209876543210');
    expect(asanaTasks.parseRef('1209876543210')).toBe('1209876543210');
    expect(mondayTasks.parseRef('https://acme.monday.com/boards/123/pulses/4567890')).toBe('4567890');
    expect(mondayTasks.parseRef('https://evil.example/whatever')).toBeNull();
  });
  it('monday labels map explicitly; unknown labels read as open', () => {
    expect(mondayStatusFromLabel('Done')).toBe('done');
    expect(mondayStatusFromLabel('Working on it')).toBe('in_progress');
    expect(mondayStatusFromLabel('Stuck')).toBe('open');
    expect(mondayLabelFor('open')).toBeNull();
  });
});

describe('transport safety', () => {
  it('redacts tokens in URLs (query and HubSpot token-info path)', () => {
    expect(redactUrl('https://api.hubapi.com/oauth/v1/access-tokens/abc.def?x=1')).toBe('https://api.hubapi.com/oauth/v1/access-tokens/<redacted>?x=1');
    expect(redactUrl('https://x.test/t?code=secret&ok=1')).toBe('https://x.test/t?code=<redacted>&ok=1');
  });
  it('classifies statuses; Mailchimp data centre host is validated', () => {
    expect([401, 403, 404, 429, 503, 500, 422].map(classifyStatus)).toEqual(['auth', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'server', 'invalid']);
    expect(mailchimpApiHost('us21')).toBe('us21.api.mailchimp.com');
    expect(() => mailchimpApiHost('evil.com/')).toThrow();
    expect(hubspotOriginToken('7c9e6679-7425-40de-944b-e07fc1f90ae7')).toBe('relay7c9e6679742540de944be07fc1f90ae7');
  });
  it('simulated transport: mock_ accounts only; lost response after a write is ambiguous; outage is 503', async () => {
    expect(() => new SimulatedBizTransport({ connector: 'asana', accountId: 'real', store: new MemorySimStore(), handler: asanaSim })).toThrow();
    const store = new MemorySimStore();
    const t = new SimulatedBizTransport({ connector: 'asana', accountId: 'mock_a', store, handler: asanaSim, scenario: 'timeout_after_send' });
    const req = { method: 'POST' as const, url: 'https://app.asana.com/api/1.0/tasks', op: 'asana.tasks.create', mutating: true, body: JSON.stringify({ data: { name: 'x', projects: ['mock_proj_1'] } }) };
    await expect(t.send(req)).rejects.toBeInstanceOf(BizTransportError);
    expect((await store.list('asana', 'mock_a', 'task')).length).toBe(1);   // it was created before the response was lost
    const o = new SimulatedBizTransport({ connector: 'asana', accountId: 'mock_a', store, handler: asanaSim, scenario: 'outage' });
    expect((await o.send({ method: 'GET', url: 'https://app.asana.com/api/1.0/users/me', op: 'asana.users.me' })).status).toBe(503);
  });
});

describe('Slack quiet hours + hub slugs', () => {
  it('quiet window across midnight in the route time zone', () => {
    expect(quietMinutesLeft({ quiet_start: '22:00', quiet_end: '07:00', timezone: 'Europe/London' }, new Date('2026-11-08T06:30:00Z'))).toBe(30);
    expect(quietMinutesLeft({ quiet_start: '09:00', quiet_end: '17:00', timezone: 'America/New_York' }, new Date('2026-11-08T15:00:00Z'))).toBe(420);
  });
  it('every connector has a reversible slug', () => {
    for (const c of HUB_CONNECTORS) expect(slugToConnector(CONNECTOR_SLUG[c])).toBe(c);
    expect(slugToConnector('nope')).toBeNull();
  });
});
