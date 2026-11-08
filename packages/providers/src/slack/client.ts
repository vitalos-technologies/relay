// Slack Web API client (V3.5 stream C). Docs checked 2026-11-08: docs.slack.dev — OAuth v2 (slack.com/oauth/v2/authorize,
// oauth.v2.access), chat.postMessage / chat.update, conversations.list (public + private channels the app can see),
// auth.test, auth.revoke, interactivity (block_actions payloads, response_url on hooks.slack.com), request signing.
// Least privilege: chat:write, channels:read, groups:read. No users:read.email — Slack identities are linked to Relay
// people only by an explicit, signed-in linking action (never by matching names or emails).
import { BizApiError, apiError, form, parseJson, retryAfterMs, type BizResponse, type BizTransport } from '../biz/transport.js';

export const SLACK_API = 'https://slack.com/api';
export const SLACK_AUTHORIZE = 'https://slack.com/oauth/v2/authorize';
export const SLACK_SCOPES = ['chat:write', 'channels:read', 'groups:read'] as const;
export const SLACK_HOSTS = ['slack.com', 'hooks.slack.com'] as const;

export interface SlackCall { t: BizTransport; token: string }
export interface SlackChannel { id: string; name: string; is_private: boolean; is_member: boolean }

const AUTH_ERRORS = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed', 'token_expired']);
const PERM_ERRORS = new Set(['missing_scope', 'not_in_channel', 'channel_not_found', 'is_archived', 'restricted_action']);

function check<T>(res: BizResponse): T {
  const j = parseJson<T & { ok?: boolean; error?: string }>(res.body);
  if (res.status === 429) throw new BizApiError('Slack: rate limited', 'rate_limited', 429, 'ratelimited', retryAfterMs(res.headers) ?? 30_000);
  if (res.status === 200 && j?.ok) return j;
  const code = j?.error ?? null;
  if (code && AUTH_ERRORS.has(code)) throw new BizApiError(`Slack: ${code}`, 'auth', 401, code);
  if (code && PERM_ERRORS.has(code)) throw new BizApiError(`Slack: ${code}`, code === 'channel_not_found' ? 'not_found' : 'forbidden', 403, code);
  if (res.status === 200) throw new BizApiError(`Slack: ${code ?? 'request failed'}`, 'invalid', 400, code);
  throw apiError(res, `Slack: HTTP ${res.status}`, code);
}

async function api<T>(c: SlackCall, method: string, body: Record<string, unknown> | null, mutating = false): Promise<T> {
  const res = await c.t.send({ method: body ? 'POST' : 'GET', url: `${SLACK_API}/${method}`, op: `slack.${method}`, mutating,
    headers: { authorization: `Bearer ${c.token}`, ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return check<T>(res);
}

export function slackAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  return `${SLACK_AUTHORIZE}?${new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state, scope: SLACK_SCOPES.join(',') })}`;
}

export async function slackExchange(t: BizTransport, p: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<{ accessToken: string; scopes: string[]; teamId: string; teamName: string; botUserId: string | null }> {
  const res = await t.send({ method: 'POST', url: `${SLACK_API}/oauth.v2.access`, op: 'slack.oauth.v2.access', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, code: p.code }) });
  const j = check<{ access_token: string; scope?: string; team?: { id: string; name: string }; bot_user_id?: string }>(res);
  if (!j.team?.id) throw new BizApiError('Slack: no workspace in token response', 'invalid', 400);
  return { accessToken: j.access_token, scopes: (j.scope ?? '').split(',').filter(Boolean), teamId: j.team.id, teamName: j.team.name, botUserId: j.bot_user_id ?? null };
}

export const slackAuthTest = (c: SlackCall) => api<{ team_id: string; team: string; user_id: string }>(c, 'auth.test', {});

export async function slackChannels(c: SlackCall): Promise<SlackChannel[]> {
  const res = await c.t.send({ method: 'GET', url: `${SLACK_API}/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200`, op: 'slack.conversations.list', headers: { authorization: `Bearer ${c.token}` } });
  return check<{ channels: SlackChannel[] }>(res).channels.map((ch) => ({ id: ch.id, name: ch.name, is_private: !!ch.is_private, is_member: !!ch.is_member }));
}

export interface SlackBlock { type: string; [k: string]: unknown }

export const slackPost = (c: SlackCall, p: { channel: string; text: string; blocks?: SlackBlock[] }) =>
  api<{ ts: string; channel: string }>(c, 'chat.postMessage', { channel: p.channel, text: p.text, ...(p.blocks ? { blocks: p.blocks } : {}), unfurl_links: false, unfurl_media: false }, true);

export const slackUpdate = (c: SlackCall, p: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }) =>
  api<{ ts: string }>(c, 'chat.update', { channel: p.channel, ts: p.ts, text: p.text, blocks: p.blocks ?? [] }, true);

export const slackRevoke = (c: SlackCall) => api<{ revoked: boolean }>(c, 'auth.revoke', {}, true);

/** Reply to an interaction through its response_url (only https://hooks.slack.com/… is accepted). */
export async function slackRespond(t: BizTransport, responseUrl: string, p: { text: string; replace_original?: boolean; response_type?: 'ephemeral' | 'in_channel'; blocks?: SlackBlock[] }): Promise<void> {
  const u = new URL(responseUrl);
  if (u.protocol !== 'https:' || u.hostname !== 'hooks.slack.com') throw new Error('response_url host not allowed');
  const res = await t.send({ method: 'POST', url: u.toString(), op: 'slack.response_url', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', ...p }) });
  if (res.status !== 200) throw apiError(res, 'Slack: response_url refused');
}
