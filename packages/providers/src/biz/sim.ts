// V3.5 stream C — simulated business-connector APIs. Each connector's sim handler implements the endpoints its client
// calls (same URLs, verbs and response shapes as the documented API) over a durable store, so worker restarts and
// reconciliation after a lost response stay truthful. Only mock_ accounts; results are labelled "Simulated" in the UI.
// Scenarios (installation settings.sim_scenario) exercise outage, throttling, lost responses and revocation.
import { BizTransportError, type BizRequest, type BizResponse, type BizTransport } from './transport.js';

export type SimScenario = 'success' | 'outage' | 'rate_limited_once' | 'timeout_after_send' | 'revoked' | 'missing_permission';
export const SIM_SCENARIOS: SimScenario[] = ['success', 'outage', 'rate_limited_once', 'timeout_after_send', 'revoked', 'missing_permission'];

export interface SimStore {
  get(connector: string, accountId: string, type: string, id: string): Promise<Record<string, unknown> | null>;
  put(connector: string, accountId: string, type: string, id: string, data: Record<string, unknown>): Promise<void>;
  list(connector: string, accountId: string, type: string): Promise<Array<{ id: string; data: Record<string, unknown>; createdAt: string }>>;
  incr(key: string): Promise<number>;
}

export class MemorySimStore implements SimStore {
  private m = new Map<string, { id: string; data: Record<string, unknown>; createdAt: string }>();
  private c = new Map<string, number>();
  private k = (c: string, a: string, t: string, i: string) => `${c}|${a}|${t}|${i}`;
  async get(c: string, a: string, t: string, i: string) { return this.m.get(this.k(c, a, t, i))?.data ?? null; }
  async put(c: string, a: string, t: string, i: string, data: Record<string, unknown>) {
    const prev = this.m.get(this.k(c, a, t, i));
    this.m.set(this.k(c, a, t, i), { id: i, data, createdAt: prev?.createdAt ?? new Date().toISOString() });
  }
  async list(c: string, a: string, t: string) { const p = `${c}|${a}|${t}|`; return [...this.m.entries()].filter(([k]) => k.startsWith(p)).map(([, v]) => v); }
  async incr(key: string) { const n = (this.c.get(key) ?? 0) + 1; this.c.set(key, n); return n; }
}

export interface SimEnv {
  connector: string;
  accountId: string;
  scenario: SimScenario;
  store: SimStore;
  now: () => Date;
  newId: (prefix?: string) => string;
  /** Typed store helpers bound to this connector + account. */
  get: (type: string, id: string) => Promise<Record<string, unknown> | null>;
  put: (type: string, id: string, data: Record<string, unknown>) => Promise<void>;
  list: (type: string) => Promise<Array<{ id: string; data: Record<string, unknown>; createdAt: string }>>;
}

export interface SimRequest { method: BizRequest['method']; url: URL; headers: Record<string, string>; body: string; op: string; mutating: boolean }
export type SimHandler = (req: SimRequest, env: SimEnv) => Promise<BizResponse | 'lose_after_write'>;

export const sjson = (status: number, body: unknown, headers: Record<string, string> = {}): BizResponse =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

let n = 0;
export function simId(prefix = 'mock_'): string {
  n = (n + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${n.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Scenario gate applied before the connector handler. Returns a response to short-circuit, 'lose' when the handler
 * should run and the response then be lost (writes only), or null.
 */
async function gate(req: SimRequest, env: SimEnv, statuses: { auth: BizResponse; forbidden: BizResponse; outage: BizResponse; throttled: BizResponse }): Promise<BizResponse | 'lose' | null> {
  switch (env.scenario) {
    case 'revoked': return statuses.auth;
    case 'missing_permission': return req.mutating ? statuses.forbidden : null;
    case 'outage': return statuses.outage;
    case 'rate_limited_once': return (await env.store.incr(`${env.connector}:${env.accountId}:rl:${req.op}`)) === 1 ? statuses.throttled : null;
    case 'timeout_after_send': return req.mutating && (await env.store.incr(`${env.connector}:${env.accountId}:lost:${req.op}`)) === 1 ? 'lose' : null;
    default: return null;
  }
}

export interface SimulatedTransportOptions {
  connector: string;
  accountId: string;
  scenario?: SimScenario;
  store: SimStore;
  handler: SimHandler;
  /** Connector-specific error bodies for the scenario gate. */
  errors?: Partial<{ auth: BizResponse; forbidden: BizResponse; outage: BizResponse; throttled: BizResponse }>;
  now?: () => Date;
}

export class SimulatedBizTransport implements BizTransport {
  readonly mode = 'simulated' as const;
  constructor(private readonly o: SimulatedTransportOptions) {
    if (!o.accountId.startsWith('mock_')) throw new Error('Simulated transports serve mock_ installations only');
  }

  async send(req: BizRequest): Promise<BizResponse> {
    const { connector, accountId, store } = this.o;
    const env: SimEnv = {
      connector, accountId, store, scenario: this.o.scenario ?? 'success', now: this.o.now ?? (() => new Date()), newId: simId,
      get: (t, i) => store.get(connector, accountId, t, i), put: (t, i, d) => store.put(connector, accountId, t, i, d), list: (t) => store.list(connector, accountId, t),
    };
    const r: SimRequest = { method: req.method, url: new URL(req.url), headers: Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), body: req.body ?? '', op: req.op, mutating: !!req.mutating };
    const errs = {
      auth: sjson(401, { error: 'invalid_token', message: 'Simulated: token revoked' }),
      forbidden: sjson(403, { error: 'forbidden', message: 'Simulated: missing permission' }),
      outage: sjson(503, { error: 'unavailable', message: 'Simulated: provider outage' }),
      throttled: sjson(429, { error: 'rate_limited', message: 'Simulated: rate limited' }, { 'retry-after': '30' }),
      ...this.o.errors,
    };
    const g = await gate(r, env, errs);
    if (g && g !== 'lose') return g;
    const out = await this.o.handler(r, env);
    if (out === 'lose_after_write' || g === 'lose') throw new BizTransportError('simulated: response lost after the request was sent', 'timeout', true);
    return out;
  }
}
