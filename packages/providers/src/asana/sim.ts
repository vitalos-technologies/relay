// Simulated Asana API (mock_ installations only). Mirrors the endpoints asana/client.ts calls.
import { sjson, type SimEnv, type SimHandler, type SimRequest, type SimStore } from '../biz/sim.js';

const ok = (data: unknown) => sjson(200, { data });
const err = (status: number, message: string) => sjson(status, { errors: [{ message }] });

async function seed(env: SimEnv): Promise<void> {
  if (await env.get('workspace', 'mock_ws_1')) return;
  await env.put('workspace', 'mock_ws_1', { gid: 'mock_ws_1', name: 'Simulated workspace' });
  for (const [gid, name] of [['mock_proj_1', 'Customer care follow-ups'], ['mock_proj_2', 'Campaign production']] as const) {
    await env.put('project', gid, { gid, name, permalink_url: `https://app.asana.com/0/${gid}` });
  }
  for (const [gid, name] of [['mock_user_1', 'Alex (simulated)'], ['mock_user_2', 'Sam (simulated)']] as const) await env.put('user', gid, { gid, name });
}

function view(t: Record<string, unknown>) {
  return { gid: t.gid, name: t.name, notes: t.notes ?? '', completed: !!t.completed, due_on: t.due_on ?? null, assignee: t.assignee ?? null,
    permalink_url: `https://app.asana.com/0/0/${String(t.gid)}`, modified_at: t.modified_at, external: t.external ?? null };
}

export const asanaSim: SimHandler = async (req: SimRequest, env: SimEnv) => {
  await seed(env);
  const path = req.url.pathname.replace(/^\/api\/1\.0/, '');
  const body = req.body ? (JSON.parse(req.body) as { data?: Record<string, unknown> }).data ?? {} : {};
  if (req.url.pathname === '/-/oauth_token') return sjson(200, { access_token: `mock_at_${env.newId('')}`, refresh_token: 'mock_rt', expires_in: 3600, data: { gid: 'mock_user_1', name: 'Alex (simulated)' } });
  if (path === '/users/me') return ok({ gid: 'mock_user_1', name: 'Alex (simulated)', workspaces: [{ gid: 'mock_ws_1', name: 'Simulated workspace' }] });
  if (path === '/workspaces') return ok((await env.list('workspace')).map((w) => w.data));
  if (path === '/projects' && req.method === 'GET') return ok((await env.list('project')).map((p) => p.data));
  if (path === '/users' && req.method === 'GET') return ok((await env.list('user')).map((p) => p.data));
  if (path === '/tasks' && req.method === 'POST') {
    const proj = (body.projects as string[] | undefined)?.[0];
    if (!proj || !(await env.get('project', proj))) return err(404, 'project: Not a recognized ID');
    if (!body.name) return err(400, 'name: Missing input');
    const gid = env.newId('mock_task_');
    const t = { gid, name: body.name, notes: body.notes ?? '', completed: false, due_on: body.due_on ?? null, project: proj,
      assignee: body.assignee ? { gid: body.assignee, name: String((await env.get('user', String(body.assignee)))?.name ?? 'Unknown') } : null,
      external: body.external ?? null, modified_at: env.now().toISOString() };
    await env.put('task', gid, t);
    return sjson(201, { data: view(t) });
  }
  const m = /^\/tasks\/([^/]+)$/.exec(path);
  if (m) {
    const t = await env.get('task', m[1]!);
    if (!t || t.deleted) return err(404, 'task: Not Found');
    if (req.method === 'GET') return ok(view(t));
    if (req.method === 'PUT') {
      const next = { ...t, ...Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'due_on', 'completed', 'notes'].includes(k))), modified_at: env.now().toISOString() };
      await env.put('task', m[1]!, next);
      return ok(view(next));
    }
  }
  const pt = /^\/projects\/([^/]+)\/tasks$/.exec(path);
  if (pt) return ok((await env.list('task')).map((x) => x.data).filter((x) => x.project === pt[1] && !x.deleted).map(view));
  if (path === '/webhooks' && req.method === 'POST') { const gid = env.newId('mock_hook_'); await env.put('webhook', gid, { gid, ...body }); return sjson(201, { data: { gid } }); }
  return err(404, `simulated Asana: no route ${req.method} ${path}`);
};

/** Simulate a person editing the task in Asana (for demos/tests). Returns the compact webhook event body. */
export async function asanaSimExternalEdit(store: SimStore, accountId: string, gid: string, patch: { name?: string; completed?: boolean; due_on?: string | null; deleted?: boolean }): Promise<string> {
  const t = await store.get('asana', accountId, 'task', gid);
  if (!t) throw new Error('unknown simulated task');
  await store.put('asana', accountId, 'task', gid, { ...t, ...patch, modified_at: new Date().toISOString() });
  return JSON.stringify({ events: [{ action: patch.deleted ? 'deleted' : 'changed', resource: { gid, resource_type: 'task' }, created_at: new Date().toISOString(), user: { gid: 'mock_user_2' } }] });
}
