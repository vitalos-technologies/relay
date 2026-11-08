// Mailchimp Marketing API client (V3.5 stream C). Docs checked 2026-11-08: mailchimp.com/developer/marketing —
// OAuth 2 (login.mailchimp.com/oauth2/authorize, /oauth2/token, /oauth2/metadata → data centre + api_endpoint; tokens do
// not expire; access is account-wide, no granular scopes), lists (audiences), campaigns (create → status "save" = draft),
// campaign content (PUT), reports, webhooks (X-Mailchimp-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, ts + "." + body)>).
// Deliberately NOT implemented: campaigns/{id}/actions/send|schedule|test, lists/{id}/members writes. Relay creates
// drafts and reads results; sending stays a separate action in Mailchimp. Nobody is ever subscribed by Relay.
import { apiError, form, parseJson, type BizTransport } from '../biz/transport.js';

export const MAILCHIMP_AUTHORIZE = 'https://login.mailchimp.com/oauth2/authorize';
export const MAILCHIMP_TOKEN = 'https://login.mailchimp.com/oauth2/token';
export const MAILCHIMP_METADATA = 'https://login.mailchimp.com/oauth2/metadata';
export const MAILCHIMP_LOGIN_HOST = 'login.mailchimp.com';

/** Data-centre API host, e.g. us21.api.mailchimp.com (validated; the only dynamic host any connector uses). */
export function mailchimpApiHost(dc: string): string {
  if (!/^[a-z]{2}\d{1,3}$/.test(dc)) throw new Error('invalid Mailchimp data centre');
  return `${dc}.api.mailchimp.com`;
}

export interface MailchimpCall { t: BizTransport; token: string; dc: string }
export interface MailchimpCampaign { id: string; web_id: number; status: string; settings: { title?: string; subject_line?: string }; recipients: { list_id?: string }; archive_url?: string; create_time?: string; emails_sent?: number }

async function call<T>(c: MailchimpCall, method: 'GET' | 'POST' | 'PUT', path: string, op: string, body?: unknown): Promise<T> {
  if (/\/actions\/(send|schedule|test)|\/members/.test(path) && method !== 'GET') throw new Error('Relay never sends campaigns or changes audience members');
  const res = await c.t.send({ method, url: `https://${mailchimpApiHost(c.dc)}/3.0${path}`, op, mutating: method !== 'GET',
    headers: { authorization: `Bearer ${c.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = parseJson<T & { title?: string; detail?: string }>(res.body);
  if (res.status >= 200 && res.status < 300 && j) return j;
  throw apiError(res, `Mailchimp: ${(j?.detail ?? j?.title ?? `HTTP ${res.status}`).slice(0, 160)}`, j?.title ?? null);
}

export function mailchimpAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  return `${MAILCHIMP_AUTHORIZE}?${new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state })}`;
}

export async function mailchimpExchange(t: BizTransport, p: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<{ accessToken: string }> {
  const res = await t.send({ method: 'POST', url: MAILCHIMP_TOKEN, op: 'mailchimp.oauth.token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, code: p.code }) });
  const j = parseJson<{ access_token?: string }>(res.body);
  if (res.status !== 200 || !j?.access_token) throw apiError(res, 'Mailchimp: token request was refused');
  return { accessToken: j.access_token };
}

export async function mailchimpMetadata(t: BizTransport, token: string): Promise<{ dc: string; accountName: string; loginId: string }> {
  const res = await t.send({ method: 'GET', url: MAILCHIMP_METADATA, op: 'mailchimp.oauth.metadata', headers: { authorization: `OAuth ${token}` } });
  const j = parseJson<{ dc?: string; accountname?: string; login?: { login_id?: number | string } }>(res.body);
  if (res.status !== 200 || !j?.dc) throw apiError(res, 'Mailchimp: account metadata unavailable');
  return { dc: j.dc, accountName: j.accountname ?? 'Mailchimp account', loginId: String(j.login?.login_id ?? j.accountname ?? j.dc) };
}

export const mailchimpPing = (c: MailchimpCall) => call<{ health_status: string }>(c, 'GET', '/ping', 'mailchimp.ping');

export const mailchimpAudiences = (c: MailchimpCall) =>
  call<{ lists: Array<{ id: string; name: string; stats?: { member_count?: number } }> }>(c, 'GET', '/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count', 'mailchimp.lists.list').then((r) => r.lists);

export const mailchimpCampaigns = (c: MailchimpCall) =>
  call<{ campaigns: MailchimpCampaign[] }>(c, 'GET', '/campaigns?count=50&sort_field=create_time&sort_dir=DESC', 'mailchimp.campaigns.list').then((r) => r.campaigns);

/** Create a DRAFT regular campaign (status "save") and set its HTML. Never sends. */
export async function mailchimpCreateDraft(c: MailchimpCall, p: { listId: string; title: string; subject: string; previewText: string | null; fromName: string | null; replyTo: string | null; html: string }): Promise<MailchimpCampaign> {
  const camp = await call<MailchimpCampaign>(c, 'POST', '/campaigns', 'mailchimp.campaigns.create', {
    type: 'regular', recipients: { list_id: p.listId },
    settings: { title: p.title, subject_line: p.subject, ...(p.previewText ? { preview_text: p.previewText } : {}), ...(p.fromName ? { from_name: p.fromName } : {}), ...(p.replyTo ? { reply_to: p.replyTo } : {}) },
  });
  await call(c, 'PUT', `/campaigns/${encodeURIComponent(camp.id)}/content`, 'mailchimp.campaigns.content', { html: p.html });
  return camp;
}

export const mailchimpGetCampaign = (c: MailchimpCall, id: string) => call<MailchimpCampaign>(c, 'GET', `/campaigns/${encodeURIComponent(id)}`, 'mailchimp.campaigns.get');

export async function mailchimpReport(c: MailchimpCall, id: string): Promise<{ emails_sent: number | null; opens: number | null; clicks: number | null; unsubscribed: number | null }> {
  const r = await call<{ emails_sent?: number; opens?: { unique_opens?: number }; clicks?: { unique_subscriber_clicks?: number }; unsubscribed?: number }>(c, 'GET', `/reports/${encodeURIComponent(id)}`, 'mailchimp.reports.get');
  return { emails_sent: r.emails_sent ?? null, opens: r.opens?.unique_opens ?? null, clicks: r.clicks?.unique_subscriber_clicks ?? null, unsubscribed: r.unsubscribed ?? null };
}

/** Reconcile an unknown create: recent campaigns whose internal title carries the origin marker. */
export async function mailchimpFindByMarker(c: MailchimpCall, marker: string): Promise<MailchimpCampaign | null> {
  return (await mailchimpCampaigns(c)).find((x) => x.settings.title?.includes(marker)) ?? null;
}

export const mailchimpCampaignUrl = (dc: string, webId: number) => `https://${dc}.admin.mailchimp.com/campaigns/edit?id=${webId}`;
