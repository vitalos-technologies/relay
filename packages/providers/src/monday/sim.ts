// Simulated monday.com API (mock_ installations only). Dispatches on the client's operation label; responses use the
// documented GraphQL shapes (data / errors, complexity).
import { sjson, type SimEnv, type SimHandler, type SimStore } from '../biz/sim.js';

const data = (d: Record<string, unknown>) => sjson(200, { data: { ...d, complexity: { after: 9_990_000, reset_in_x_seconds: 60 } }, account_id: 1 });
const gerr = (message: string, code: string) => sjson(200, { errors: [{ message, extensions: { code } }], account_id: 1 });

async function seed(env: SimEnv) {
  if (await env.get('board', 'mock_board_1')) return;
  const columns = [{ id: 'name', title: 'Name', type: 'name' }, { id: 'status', title: 'Status', type: 'status' }, { id: 'date4', title: 'Due date', type: 'date' }, { id: 'priority', title: 'Priority', type: 'status' }];
  await env.put('board', 'mock_board_1', { id: 'mock_board_1', name: 'Campaign briefs', url: 'https://example.monday.com/boards/mock_board_1', groups: [{ id: 'topics', title: 'This week' }], columns });
  await env.put('board', 'mock_board_2', { id: 'mock_board_2', name: 'Care escalations', url: 'https://example.monday.com/boards/mock_board_2', groups: [{ id: 'new', title: 'New' }], columns });
}

function columnValues(item: Record<string, unknown>) {
  const cols = (item.columns ?? {}) as Record<string, { text: string | null; value: string | null; type: string }>;
  return Object.entries(cols).map(([id, c]) => ({ id, ...c }));
}
const view = (i: Record<string, unknown>) => ({ id: i.id, name: i.name, url: `https://example.monday.com/boards/${String(i.board)}/pulses/${String(i.id)}`, state: i.state ?? 'active', updated_at: i.updated_at, column_values: columnValues(i) });

function applyColumns(prev: Record<string, { text: string | null; value: string | null; type: string }>, v: Record<string, unknown>) {
  const next = { ...prev };
  for (const [id, raw] of Object.entries(v)) {
    if (id === 'name') continue;
    if (raw === '' || raw === null) { next[id] = { text: null, value: null, type: id.startsWith('date') ? 'date' : 'status' }; continue; }
    const o = raw as { label?: string; date?: string };
    if (o.label !== undefined) next[id] = { text: o.label, value: JSON.stringify({ label: o.label }), type: 'status' };
    else if (o.date !== undefined) next[id] = { text: o.date, value: JSON.stringify({ date: o.date }), type: 'date' };
  }
  return next;
}

export const mondaySim: SimHandler = async (req, env) => {
  await seed(env);
  if (req.url.hostname === 'auth.monday.com') return sjson(200, { access_token: `mock_at_${env.newId('')}`, token_type: 'Bearer', scope: 'boards:read boards:write users:read webhooks:write' });
  const { variables = {} } = (req.body ? JSON.parse(req.body) : {}) as { variables?: Record<string, unknown> };
  switch (req.op) {
    case 'monday.me': return data({ me: { id: 'mock_user_1', name: 'Jordan (simulated)', account: { id: env.accountId, name: 'Simulated account', slug: 'example' } } });
    case 'monday.boards.list': return data({ boards: (await env.list('board')).map((b) => b.data) });
    case 'monday.users.list': return data({ users: [{ id: 'mock_user_1', name: 'Jordan (simulated)' }, { id: 'mock_user_2', name: 'Riley (simulated)' }] });
    case 'monday.items.create': {
      const board = await env.get('board', String(variables.b));
      if (!board) return gerr('Board not found', 'ResourceNotFoundException');
      const id = env.newId('mock_item_');
      const item = { id, board: variables.b, group: variables.g, name: variables.n, state: 'active', updated_at: env.now().toISOString(), columns: applyColumns({}, JSON.parse(String(variables.v ?? '{}'))), updates: [] as string[] };
      await env.put('item', id, item);
      return data({ create_item: { id, url: view(item).url } });
    }
    case 'monday.updates.create': {
      const it = await env.get('item', String(variables.i));
      if (!it) return gerr('Item not found', 'ResourceNotFoundException');
      await env.put('item', String(variables.i), { ...it, updates: [...((it.updates as string[]) ?? []), String(variables.body)] });
      return data({ create_update: { id: env.newId('mock_upd_') } });
    }
    case 'monday.items.get': {
      const it = await env.get('item', String((variables.ids as string[])[0]));
      return data({ items: it ? [view(it)] : [] });
    }
    case 'monday.items.update': {
      const it = await env.get('item', String(variables.i));
      if (!it || it.state === 'deleted') return gerr('Item not found', 'ResourceNotFoundException');
      const v = JSON.parse(String(variables.v ?? '{}')) as Record<string, unknown>;
      const next = { ...it, name: typeof v.name === 'string' ? v.name : it.name, columns: applyColumns(it.columns as never, v), updated_at: env.now().toISOString() };
      await env.put('item', String(variables.i), next);
      return data({ change_multiple_column_values: { id: variables.i } });
    }
    case 'monday.items.find': {
      const items = (await env.list('item')).map((x) => x.data).filter((x) => x.board === (variables.b as string[])[0]);
      return data({ boards: [{ items_page: { items: items.map((i) => ({ ...view(i), updates: ((i.updates as string[]) ?? []).map((body) => ({ body })) })) } }] });
    }
    case 'monday.webhooks.create': return data({ create_webhook: { id: env.newId('mock_hook_') } });
    default: return gerr(`simulated monday.com: unsupported operation ${req.op}`, 'InvalidOperation');
  }
};

/** Simulate a person changing the item in monday.com. Returns the webhook body monday would send. */
export async function mondaySimExternalEdit(store: SimStore, accountId: string, itemId: string, patch: { name?: string; status?: string | null; date?: string | null; deleted?: boolean }): Promise<string> {
  const it = await store.get('monday', accountId, 'item', itemId);
  if (!it) throw new Error('unknown simulated item');
  const v: Record<string, unknown> = {};
  if (patch.status !== undefined) v.status = patch.status === null ? '' : { label: patch.status };
  if (patch.date !== undefined) v.date4 = patch.date === null ? '' : { date: patch.date };
  await store.put('monday', accountId, 'item', itemId, { ...it, name: patch.name ?? it.name, state: patch.deleted ? 'deleted' : it.state, columns: applyColumns(it.columns as never, v), updated_at: new Date().toISOString() });
  return JSON.stringify({ event: { type: patch.deleted ? 'delete_pulse' : 'update_column_value', boardId: it.board, pulseId: itemId, triggerUuid: `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`, triggerTime: new Date().toISOString() } });
}
