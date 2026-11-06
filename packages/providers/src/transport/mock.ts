// Mock transport: routes the adapters' REAL outgoing requests to an in-process simulation of
// each provider API. Used only for connections with is_mock = true (provider_account_id
// "mock_..."), only when ENABLE_MOCK_PROVIDERS is on, and never in production.
// Results from mock connections are always labelled "Simulated" in the UI.
import { TransportError, type HttpRequest, type HttpResponse, type Provider, type Transport } from '@social-lite/core';

/**
 * Scenario controls for simulated destinations (set on connections.metadata.mock_scenario,
 * or per-variant options.mockScenario in tests/demos).
 */
export type MockScenario =
  | 'success'
  | 'fail_permanent'        // provider rejects the content (invalid/unsupported)
  | 'fail_transient_once'   // first publish attempt gets a documented-transient error, then succeeds
  | 'timeout_after_send'    // provider creates the post but the response is lost => Unknown
  | 'rate_limited_once'     // first publish attempt gets 429 with Retry-After
  | 'processing'            // async processing for a few polls before success (IG/X media)
  | 'revoked'               // token revoked/expired => reconnect required
  | 'missing_permission';   // token lacks publish permission

export const MOCK_SCENARIOS: MockScenario[] = [
  'success', 'fail_permanent', 'fail_transient_once', 'timeout_after_send', 'rate_limited_once', 'processing', 'revoked', 'missing_permission',
];

export interface MockObject {
  provider: Provider;
  accountId: string;
  objectId: string;          // always begins with "mock_"
  kind: string;              // 'post' | 'container' | 'media' | 'message'
  data: Record<string, unknown>;
  createdAt: string;
}

/** Durable store for simulated provider objects so reconciliation survives worker restarts. */
export interface MockStore {
  put(o: MockObject): Promise<void>;
  get(provider: Provider, objectId: string): Promise<MockObject | null>;
  list(provider: Provider, accountId: string, kind?: string): Promise<MockObject[]>;
  /** Atomic counter used for "once" scenarios, keyed e.g. by delivery id. */
  incr(key: string): Promise<number>;
}

export class MemoryMockStore implements MockStore {
  private objs = new Map<string, MockObject>();
  private counters = new Map<string, number>();
  async put(o: MockObject) { this.objs.set(`${o.provider}:${o.objectId}`, o); }
  async get(p: Provider, id: string) { return this.objs.get(`${p}:${id}`) ?? null; }
  async list(p: Provider, a: string, kind?: string) {
    return [...this.objs.values()].filter((o) => o.provider === p && o.accountId === a && (!kind || o.kind === kind));
  }
  async incr(key: string) { const n = (this.counters.get(key) ?? 0) + 1; this.counters.set(key, n); return n; }
}

export interface FakeEnv {
  provider: Provider;
  accountId: string;
  scenario: MockScenario;
  store: MockStore;
  now: () => Date;
  newId: (prefix?: string) => string;
}

/** A provider's simulated API. Implemented per provider in <provider>/fake.ts. */
export type FakeHandler = (req: HttpRequest, env: FakeEnv) => Promise<HttpResponse>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

/** Throw after the fake provider has already "created" the object: the response is lost. */
export function lostResponse(): never {
  throw new TransportError('simulated: connection reset after request was sent', 'timeout', true);
}

let counter = 0;
export function mockId(prefix = 'mock_'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class MockTransport implements Transport {
  readonly mode = 'mock' as const;
  constructor(
    private readonly handler: FakeHandler,
    private readonly env: Omit<FakeEnv, 'now' | 'newId'> & Partial<Pick<FakeEnv, 'now' | 'newId'>>,
    private readonly latencyMs = 0,
  ) {
    if (!env.accountId.startsWith('mock_')) throw new Error('MockTransport may only serve mock_ destinations');
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    return this.handler(req, { now: () => new Date(), newId: mockId, ...this.env });
  }
}
