// Asana REST API client (V3.5 stream C). Docs checked 2026-11-08: developers.asana.com/docs/oauth (PKCE, endpoints),
// /docs/oauth-scopes (tasks:read/write, projects:read, users:read, workspaces:read, webhooks:write), /reference/createtask,
// /reference/updatetask, /reference/gettask, /reference/gettasksforproject, /docs/webhooks-guide.
// Least privilege: Relay never deletes tasks (no tasks:delete). Tasks carry the origin marker in `external.gid`
// (app-owned field) so an unknown create can be reconciled and echoes recognised.
import { apiError, form, parseJson, type BizResponse, type BizTransport } from '../biz/transport.js';

export const ASANA_API = 'https://app.asana.com/api/1.0';
export const ASANA_AUTHORIZE = 'https://app.asana.com/-/oauth_authorize';
export const ASANA_TOKEN = 'https://app.asana.com/-/oauth_token';
export const ASANA_SCOPES = ['tasks:read', 'tasks:write', 'projects:read', 'users:read', 'workspaces:read', 'webhooks:write'] as const;
export const ASANA_HOSTS = ['app.asana.com'] as const;

export interface AsanaCall { t: BizTransport; token: string }
export interface AsanaTask {
  gid: string; name: string; notes: string; completed: boolean; due_on: string | null; assignee: { gid: string; name: string } | null;
  permalink_url: string | null; modified_at: string | null; external: { gid: string | null; data: string | null } | null;
}

const TASK_FIELDS = 'name,notes,completed,due_on,assignee.name,permalink_url,modified_at,external';

async function call<T>(c: AsanaCall, method: 'GET' | 'POST' | 'PUT', path: string, op: string, body?: unknown): Promise<T> {
  const res = await c.t.send({ method, url: `${ASANA_API}${path}`, op, mutating: method !== 'GET',
    headers: { authorization: `Bearer ${c.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify({ data: body }) : undefined });
  return unwrap<T>(res);
}

function unwrap<T>(res: BizResponse): T {
  const j = parseJson<{ data?: T; errors?: Array<{ message?: string }> }>(res.body);
  if (res.status >= 200 && res.status < 300 && j && 'data' in j) return j.data as T;
  throw apiError(res, `Asana: ${j?.errors?.[0]?.message?.slice(0, 160) ?? `HTTP ${res.status}`}`);
}

export function asanaAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const q = new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code', state: p.state, code_challenge: p.codeChallenge, code_challenge_method: 'S256', scope: ASANA_SCOPES.join(' ') });
  return `${ASANA_AUTHORIZE}?${q}`;
}

export interface OAuthTokens { accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string[] | null }

export async function asanaExchange(t: BizTransport, p: { clientId: string; clientSecret: string; redirectUri: string; code?: string; codeVerifier?: string; refreshToken?: string }): Promise<OAuthTokens & { userGid: string | null; userName: string | null }> {
  const res = await t.send({ method: 'POST', url: ASANA_TOKEN, op: 'asana.oauth.token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(p.refreshToken ? { grant_type: 'refresh_token', client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, refresh_token: p.refreshToken }
      : { grant_type: 'authorization_code', client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, code: p.code, code_verifier: p.codeVerifier }) });
  const j = parseJson<{ access_token?: string; refresh_token?: string; expires_in?: number; data?: { gid?: string; name?: string } }>(res.body);
  if (res.status !== 200 || !j?.access_token) throw apiError(res, 'Asana: token request was refused');
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? p.refreshToken ?? null, expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null,
    scopes: null, userGid: j.data?.gid ?? null, userName: j.data?.name ?? null };
}

export const asanaMe = (c: AsanaCall) => call<{ gid: string; name: string; workspaces: Array<{ gid: string; name: string }> }>(c, 'GET', '/users/me?opt_fields=name,workspaces.name', 'asana.users.me');
export const asanaWorkspaces = (c: AsanaCall) => call<Array<{ gid: string; name: string }>>(c, 'GET', '/workspaces?limit=100', 'asana.workspaces.list');
export const asanaProjects = (c: AsanaCall, workspaceGid: string) =>
  call<Array<{ gid: string; name: string; permalink_url?: string }>>(c, 'GET', `/projects?workspace=${encodeURIComponent(workspaceGid)}&archived=false&limit=100&opt_fields=name,permalink_url`, 'asana.projects.list');
export const asanaUsers = (c: AsanaCall, workspaceGid: string) =>
  call<Array<{ gid: string; name: string }>>(c, 'GET', `/users?workspace=${encodeURIComponent(workspaceGid)}&limit=100&opt_fields=name`, 'asana.users.list');

export async function asanaCreateTask(c: AsanaCall, p: { projectGid: string; name: string; notes: string; dueOn: string | null; assigneeGid: string | null; originMarker: string }): Promise<AsanaTask> {
  return call<AsanaTask>(c, 'POST', `/tasks?opt_fields=${TASK_FIELDS}`, 'asana.tasks.create', {
    name: p.name, notes: p.notes, projects: [p.projectGid], ...(p.dueOn ? { due_on: p.dueOn } : {}), ...(p.assigneeGid ? { assignee: p.assigneeGid } : {}),
    external: { gid: p.originMarker, data: 'relay' },
  });
}

export const asanaGetTask = (c: AsanaCall, gid: string) => call<AsanaTask>(c, 'GET', `/tasks/${encodeURIComponent(gid)}?opt_fields=${TASK_FIELDS}`, 'asana.tasks.get');

export async function asanaUpdateTask(c: AsanaCall, gid: string, p: { name?: string; due_on?: string | null; completed?: boolean }): Promise<AsanaTask> {
  return call<AsanaTask>(c, 'PUT', `/tasks/${encodeURIComponent(gid)}?opt_fields=${TASK_FIELDS}`, 'asana.tasks.update', p);
}

/** Reconcile an unknown create: recent tasks in the project carrying our origin marker. */
export async function asanaFindByMarker(c: AsanaCall, projectGid: string, marker: string): Promise<AsanaTask | null> {
  const tasks = await call<AsanaTask[]>(c, 'GET', `/projects/${encodeURIComponent(projectGid)}/tasks?limit=100&opt_fields=${TASK_FIELDS}`, 'asana.tasks.list');
  return tasks.find((x) => x.external?.gid === marker) ?? null;
}

/** Webhook on a project (Asana performs the X-Hook-Secret handshake against `target` before answering). */
export const asanaCreateWebhook = (c: AsanaCall, resourceGid: string, target: string) =>
  call<{ gid: string }>(c, 'POST', '/webhooks', 'asana.webhooks.create', { resource: resourceGid, target, filters: [{ resource_type: 'task', action: 'changed' }, { resource_type: 'task', action: 'deleted' }] });
