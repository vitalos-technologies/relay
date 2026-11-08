// monday.com GraphQL API client (V3.5 stream C). Docs checked 2026-11-08: developer.monday.com/api-reference
// (items: create_item(board_id, group_id, item_name, column_values JSON); change_multiple_column_values; webhooks;
// OAuth auth.monday.com/oauth2/authorize + /oauth2/token; API-Version header; complexity budget).
// Rate-limit observation: every query also asks for `complexity { after reset_in_x_seconds }` (the provider's own figure).
// The origin marker goes into an item update (comment) so an unknown create can be reconciled.
import { BizApiError, apiError, form, parseJson, type BizTransport } from '../biz/transport.js';

export const MONDAY_API = 'https://api.monday.com/v2';
export const MONDAY_AUTHORIZE = 'https://auth.monday.com/oauth2/authorize';
export const MONDAY_TOKEN = 'https://auth.monday.com/oauth2/token';
export const MONDAY_SCOPES = ['boards:read', 'boards:write', 'users:read', 'webhooks:write'] as const;
export const MONDAY_HOSTS = ['api.monday.com', 'auth.monday.com'] as const;
export const MONDAY_DEFAULT_API_VERSION = '2026-04';

export interface MondayCall { t: BizTransport; token: string; apiVersion?: string }
export interface MondayComplexity { after: number; reset_in_x_seconds: number }
export interface MondayColumn { id: string; title: string; type: string }
export interface MondayBoard { id: string; name: string; url: string | null; groups: Array<{ id: string; title: string }>; columns: MondayColumn[] }
export interface MondayItem { id: string; name: string; url: string | null; state: string; updated_at: string | null; column_values: Array<{ id: string; text: string | null; value: string | null; type: string }> }

export let lastComplexity: MondayComplexity | null = null;

async function gql<T>(c: MondayCall, op: string, query: string, variables: Record<string, unknown> = {}, mutating = false): Promise<T> {
  const res = await c.t.send({ method: 'POST', url: MONDAY_API, op, mutating,
    headers: { authorization: c.token, 'content-type': 'application/json', 'api-version': c.apiVersion ?? MONDAY_DEFAULT_API_VERSION }, body: JSON.stringify({ query, variables }) });
  const j = parseJson<{ data?: T & { complexity?: MondayComplexity }; errors?: Array<{ message?: string; extensions?: { code?: string; retry_in_seconds?: number } }>; error_code?: string; error_message?: string }>(res.body);
  if (res.status === 200 && j?.data && !j.errors?.length) {
    if (j.data.complexity) lastComplexity = j.data.complexity;
    return j.data;
  }
  const e = j?.errors?.[0];
  const code = e?.extensions?.code ?? j?.error_code ?? null;
  if (code === 'ComplexityException' || code === 'RATE_LIMIT_EXCEEDED' || code === 'COMPLEXITY_BUDGET_EXHAUSTED' || res.status === 429) {
    throw new BizApiError('monday.com: rate limit reached', 'rate_limited', res.status, code, (e?.extensions?.retry_in_seconds ?? 30) * 1000);
  }
  if (res.status === 200 && code === 'ResourceNotFoundException') throw new BizApiError('monday.com: item or board not found', 'not_found', 404, code);
  if (res.status === 200) throw new BizApiError(`monday.com: ${(e?.message ?? j?.error_message ?? 'request failed').slice(0, 160)}`, 'invalid', 400, code);
  throw apiError(res, `monday.com: ${(e?.message ?? j?.error_message ?? `HTTP ${res.status}`).slice(0, 160)}`, code);
}

export function mondayAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  return `${MONDAY_AUTHORIZE}?${new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state, scope: MONDAY_SCOPES.join(' ') })}`;
}

export async function mondayExchange(t: BizTransport, p: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<{ accessToken: string; scopes: string[] | null }> {
  const res = await t.send({ method: 'POST', url: MONDAY_TOKEN, op: 'monday.oauth.token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, code: p.code }) });
  const j = parseJson<{ access_token?: string; scope?: string }>(res.body);
  if (res.status !== 200 || !j?.access_token) throw apiError(res, 'monday.com: token request was refused');
  return { accessToken: j.access_token, scopes: j.scope ? j.scope.split(/[ ,]+/).filter(Boolean) : null };
}

export const mondayMe = (c: MondayCall) => gql<{ me: { id: string; name: string; account: { id: string; name: string; slug: string } } }>(c, 'monday.me',
  'query { me { id name account { id name slug } } complexity { after reset_in_x_seconds } }').then((d) => d.me);

export const mondayBoards = (c: MondayCall) => gql<{ boards: MondayBoard[] }>(c, 'monday.boards.list',
  'query { boards(limit: 50, state: active) { id name url groups { id title } columns { id title type } } complexity { after reset_in_x_seconds } }').then((d) => d.boards);

export const mondayUsers = (c: MondayCall) => gql<{ users: Array<{ id: string; name: string }> }>(c, 'monday.users.list', 'query { users(limit: 100) { id name } }').then((d) => d.users);

export async function mondayCreateItem(c: MondayCall, p: { boardId: string; groupId: string | null; name: string; columnValues: Record<string, unknown>; summary: string; originMarker: string }): Promise<MondayItem> {
  const d = await gql<{ create_item: { id: string; url: string | null } }>(c, 'monday.items.create',
    'mutation ($b: ID!, $g: String, $n: String!, $v: JSON) { create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v) { id url } complexity { after reset_in_x_seconds } }',
    { b: p.boardId, g: p.groupId, n: p.name, v: JSON.stringify(p.columnValues) }, true);
  // Summary + origin marker as the item's first update (comment). Best effort: the item exists either way.
  await gql(c, 'monday.updates.create', 'mutation ($i: ID!, $body: String!) { create_update(item_id: $i, body: $body) { id } }',
    { i: d.create_item.id, body: `${p.summary}\n\n— Created from Relay (${p.originMarker})` }, true).catch(() => undefined);
  return mondayGetItem(c, d.create_item.id);
}

export async function mondayGetItem(c: MondayCall, id: string): Promise<MondayItem> {
  const d = await gql<{ items: MondayItem[] }>(c, 'monday.items.get',
    'query ($ids: [ID!]) { items(ids: $ids) { id name url state updated_at column_values { id text value type } } complexity { after reset_in_x_seconds } }', { ids: [id] });
  const it = d.items[0];
  if (!it || it.state === 'deleted') throw new BizApiError('monday.com: item not found', 'not_found', 404);
  return it;
}

export async function mondayUpdateItem(c: MondayCall, p: { boardId: string; itemId: string; columnValues: Record<string, unknown> }): Promise<MondayItem> {
  await gql(c, 'monday.items.update', 'mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } complexity { after reset_in_x_seconds } }',
    { b: p.boardId, i: p.itemId, v: JSON.stringify(p.columnValues) }, true);
  return mondayGetItem(c, p.itemId);
}

/** Reconcile an unknown create: recent items on the board whose first update carries our origin marker. */
export async function mondayFindByMarker(c: MondayCall, boardId: string, marker: string): Promise<MondayItem | null> {
  const d = await gql<{ boards: Array<{ items_page: { items: Array<MondayItem & { updates: Array<{ body: string }> }> } }> }>(c, 'monday.items.find',
    'query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 100) { items { id name url state updated_at column_values { id text value type } updates(limit: 3) { body } } } } }', { b: [boardId] });
  return d.boards[0]?.items_page.items.find((i) => i.updates.some((u) => u.body.includes(marker))) ?? null;
}

export const mondayCreateWebhook = (c: MondayCall, boardId: string, url: string) =>
  gql<{ create_webhook: { id: string } }>(c, 'monday.webhooks.create', 'mutation ($b: ID!, $u: String!) { create_webhook(board_id: $b, url: $u, event: change_column_value) { id } }', { b: boardId, u: url }, true);

/** Relay status ⇄ monday status label (explicit, documented mapping; unknown labels read as "open"). */
export function mondayStatusFromLabel(label: string | null | undefined): 'open' | 'in_progress' | 'done' {
  if (!label) return 'open';
  if (/^done$|^complete/i.test(label.trim())) return 'done';
  if (/working|progress/i.test(label)) return 'in_progress';
  return 'open';
}
/** null ⇒ clear the status column (monday's default blank label). */
export const mondayLabelFor = (s: 'open' | 'in_progress' | 'done'): string | null => (s === 'done' ? 'Done' : s === 'in_progress' ? 'Working on it' : null);
