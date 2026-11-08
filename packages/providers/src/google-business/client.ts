// Google Business Profile API client (V3.5 stream C). Docs checked 2026-11-08:
//  - OAuth: accounts.google.com/o/oauth2/v2/auth + oauth2.googleapis.com/token, scope business.manage (+ openid email for
//    the account identity). API access needs Google's approval (quota 0 until granted).
//  - Accounts: mybusinessaccountmanagement v1 accounts.list. Locations: mybusinessbusinessinformation v1
//    accounts.locations.list (readMask). Local posts: mybusiness v4 accounts.locations.localPosts (create/list/get/patch/
//    delete; topicType STANDARD; states LIVE / PROCESSING / REJECTED). Metrics: businessprofileperformance v1
//    locations.fetchMultiDailyMetricsTimeSeries. Reviews (stream B): v4 accounts.locations.reviews.
//  - Chat (Business Messages) was discontinued in July 2024 and is not offered.
// Local posts are public: no origin marker in the text. An unknown create is reconciled by exact summary + create time.
import { apiError, form, parseJson, type BizTransport } from '../biz/transport.js';

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GBP_SCOPES = ['https://www.googleapis.com/auth/business.manage'] as const;
export const GBP_IDENTITY_SCOPES = ['openid', 'email'] as const;
export const GBP_HOSTS = ['oauth2.googleapis.com', 'openidconnect.googleapis.com', 'mybusiness.googleapis.com', 'mybusinessbusinessinformation.googleapis.com',
  'mybusinessaccountmanagement.googleapis.com', 'businessprofileperformance.googleapis.com', 'www.googleapis.com'] as const;

export interface GoogleCall { t: BizTransport; token: string }
export interface GbpLocalPost { name: string; summary: string; state: string; searchUrl: string | null; createTime: string | null; topicType: string }

async function call<T>(c: GoogleCall, method: 'GET' | 'POST' | 'PATCH', url: string, op: string, body?: unknown): Promise<T> {
  const res = await c.t.send({ method, url, op, mutating: method !== 'GET', headers: { authorization: `Bearer ${c.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = parseJson<T & { error?: { message?: string; status?: string } }>(res.body);
  if (res.status >= 200 && res.status < 300 && j) return j;
  throw apiError(res, `Google: ${(j?.error?.message ?? `HTTP ${res.status}`).slice(0, 160)}`, j?.error?.status ?? null);
}

export function googleAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string; scopes: readonly string[]; loginHint?: string | null }): string {
  return `${GOOGLE_AUTHORIZE}?${new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code', state: p.state, code_challenge: p.codeChallenge,
    code_challenge_method: 'S256', scope: p.scopes.join(' '), access_type: 'offline', include_granted_scopes: 'false', prompt: 'consent', ...(p.loginHint ? { login_hint: p.loginHint } : {}) })}`;
}

export async function googleExchange(t: BizTransport, p: { clientId: string; clientSecret: string; redirectUri: string; code?: string; codeVerifier?: string; refreshToken?: string }): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string[] }> {
  const res = await t.send({ method: 'POST', url: GOOGLE_TOKEN, op: 'google.oauth.token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(p.refreshToken ? { grant_type: 'refresh_token', client_id: p.clientId, client_secret: p.clientSecret, refresh_token: p.refreshToken }
      : { grant_type: 'authorization_code', client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, code: p.code, code_verifier: p.codeVerifier }) });
  const j = parseJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>(res.body);
  if (res.status !== 200 || !j?.access_token) throw apiError(res, 'Google: token request was refused', res.status === 400 ? 'invalid_grant' : null);
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? p.refreshToken ?? null, expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null, scopes: (j.scope ?? '').split(' ').filter(Boolean) };
}

export const googleUserInfo = (c: GoogleCall) => call<{ sub: string; email?: string }>(c, 'GET', 'https://openidconnect.googleapis.com/v1/userinfo', 'google.userinfo');

export const gbpAccounts = (c: GoogleCall) =>
  call<{ accounts?: Array<{ name: string; accountName: string; type?: string }> }>(c, 'GET', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20', 'gbp.accounts.list').then((r) => r.accounts ?? []);

export async function gbpLocations(c: GoogleCall, account: string): Promise<Array<{ name: string; title: string; address: string | null }>> {
  if (!/^accounts\/[\w-]+$/.test(account)) throw new Error('invalid account name');
  const r = await call<{ locations?: Array<{ name: string; title: string; storefrontAddress?: { addressLines?: string[]; locality?: string } }> }>(c, 'GET',
    `https://mybusinessbusinessinformation.googleapis.com/v1/${account}/locations?readMask=name,title,storefrontAddress&pageSize=100`, 'gbp.locations.list');
  return (r.locations ?? []).map((l) => ({ name: l.name, title: l.title, address: [l.storefrontAddress?.addressLines?.[0], l.storefrontAddress?.locality].filter(Boolean).join(', ') || null }));
}

/** v4 parent: accounts/{a}/locations/{l}. */
const v4 = (locationName: string) => {
  if (!/^accounts\/[\w-]+\/locations\/[\w-]+$/.test(locationName)) throw new Error('invalid location name');
  return `https://mybusiness.googleapis.com/v4/${locationName}`;
};

export async function gbpCreateLocalPost(c: GoogleCall, locationName: string, p: { summary: string; languageCode: string; callToAction?: { actionType: string; url: string } | null }): Promise<GbpLocalPost> {
  return call<GbpLocalPost>(c, 'POST', `${v4(locationName)}/localPosts`, 'gbp.localPosts.create',
    { languageCode: p.languageCode, summary: p.summary, topicType: 'STANDARD', ...(p.callToAction ? { callToAction: p.callToAction } : {}) });
}

export const gbpListLocalPosts = (c: GoogleCall, locationName: string) =>
  call<{ localPosts?: GbpLocalPost[] }>(c, 'GET', `${v4(locationName)}/localPosts?pageSize=20`, 'gbp.localPosts.list').then((r) => r.localPosts ?? []);

export const gbpGetLocalPost = (c: GoogleCall, postName: string) => {
  if (!/^accounts\/[\w-]+\/locations\/[\w-]+\/localPosts\/[\w-]+$/.test(postName)) throw new Error('invalid post name');
  return call<GbpLocalPost>(c, 'GET', `https://mybusiness.googleapis.com/v4/${postName}`, 'gbp.localPosts.get');
};

export const GBP_DAILY_METRICS = ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS'] as const;

/** Daily metrics for the last `days` days (only what the API returns; missing series stay missing). */
export async function gbpMetrics(c: GoogleCall, locationName: string, days = 28): Promise<Record<string, number>> {
  const loc = locationName.split('/').slice(2).join('/');
  if (!/^locations\/[\w-]+$/.test(loc)) throw new Error('invalid location name');
  const end = new Date(); const start = new Date(Date.now() - days * 86_400_000);
  const d = (x: Date, k: 'year' | 'month' | 'day') => String(k === 'year' ? x.getUTCFullYear() : k === 'month' ? x.getUTCMonth() + 1 : x.getUTCDate());
  const q = new URLSearchParams();
  for (const m of GBP_DAILY_METRICS) q.append('dailyMetrics', m);
  for (const [p, x] of [['dailyRange.startDate', start], ['dailyRange.endDate', end]] as const) { q.set(`${p}.year`, d(x, 'year')); q.set(`${p}.month`, d(x, 'month')); q.set(`${p}.day`, d(x, 'day')); }
  const r = await call<{ multiDailyMetricTimeSeries?: Array<{ dailyMetricTimeSeries?: Array<{ dailyMetric: string; timeSeries?: { datedValues?: Array<{ value?: string }> } }> }> }>(c, 'GET',
    `https://businessprofileperformance.googleapis.com/v1/${loc}:fetchMultiDailyMetricsTimeSeries?${q}`, 'gbp.performance.fetch');
  const out: Record<string, number> = {};
  for (const s of r.multiDailyMetricTimeSeries?.flatMap((m) => m.dailyMetricTimeSeries ?? []) ?? []) {
    out[s.dailyMetric] = (s.timeSeries?.datedValues ?? []).reduce((a, v) => a + Number(v.value ?? 0), 0);
  }
  return out;
}
