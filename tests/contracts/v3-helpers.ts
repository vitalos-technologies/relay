// Shared helpers for the V3 provider contract tests (no network).
import { TransportError, type AdapterContext, type Checkpoint, type HttpRequest, type HttpResponse, type PublishConnection, type PublishInput, type PublishMedia, type PublishingAdapter, type Transport } from '@social-lite/core';
import { MemoryMockStore, mockId, type FakeHandler, type MockScenario, type MockStore } from '@social-lite/providers';

export const SECRET_ACCESS = 'acc-SECRET-TOKEN-value-123';
export const SECRET_REFRESH = 'ref-SECRET-TOKEN-value-456';

export type Responder = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
export class RecordingTransport implements Transport {
  readonly mode = 'live' as const;
  readonly requests: HttpRequest[] = [];
  constructor(private readonly respond: Responder) {}
  async send(req: HttpRequest) { this.requests.push(req); return this.respond(req); }
}
export const res = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: body === '' ? '' : JSON.stringify(body) });
export const NOW = new Date('2026-11-07T12:00:00Z');
export const ctxWith = (transport: Transport, config: AdapterContext['config'] = { clientId: 'cid', clientSecret: 'csecret' }, now: () => Date = () => NOW): AdapterContext => ({ transport, now, config });

export class Clock { t = NOW.getTime(); now = () => new Date(this.t); advance(ms: number) { this.t += ms; } }

/** A transport backed by a provider fake, recording every request; `failOn` injects one transport failure. */
export function simulated(fake: FakeHandler, provider: PublishConnection['provider'], accountId: string, scenario: MockScenario = 'success', store: MockStore = new MemoryMockStore(), config: AdapterContext['config'] = { clientId: 'cid', clientSecret: 'csecret' }) {
  const clock = new Clock();
  const state = { failOn: null as null | ((r: HttpRequest) => boolean), calls: [] as HttpRequest[] };
  const transport: Transport = {
    mode: 'mock',
    async send(req) {
      state.calls.push(req);
      if (state.failOn?.(req)) { state.failOn = null; throw new TransportError('reset', 'reset', true); }
      return fake(req, { provider, accountId, scenario, store, now: clock.now, newId: mockId });
    },
  };
  const ctx: AdapterContext = { transport, now: clock.now, config };
  return { ctx, clock, store, state };
}

export function inputOf(connection: PublishConnection, credentials: PublishInput['credentials'], over: Partial<PublishInput['variant']> = {}, media: PublishMedia[] = [], deliveryId = 'd-1'): PublishInput {
  return {
    deliveryId, attemptNumber: 1, idempotencyKey: `${deliveryId}:1`, connection, credentials, media,
    variant: { text: 'Hello world', link: null, format: media.length > 1 ? 'album' : media.length ? 'image' : 'text', buttons: [], options: {}, ...over },
  };
}

export const image = (n = 1, over: Partial<PublishMedia> = {}): PublishMedia => ({
  assetId: `img${n}`, mime: 'image/jpeg', kind: 'image', width: 1000, height: 1000, bytes: 4, url: `https://storage.example/img${n}.jpg`, load: async () => new Uint8Array([n, 2, 3, 4]), ...over,
});
export const video = (bytes: number, over: Partial<PublishMedia> = {}): PublishMedia => ({
  assetId: 'vid1', mime: 'video/mp4', kind: 'video', width: 1080, height: 1920, bytes, durationMs: 15_000, videoCodec: 'h264', audioCodec: 'aac', frameRate: 30,
  url: 'https://storage.example/vid1.mp4', load: async () => new Uint8Array(bytes).fill(7), ...over,
});

/** prepare until ready (advancing the clock on pending), or throw with the outcome. */
export async function prepareUntilReady(adapter: PublishingAdapter, ctx: AdapterContext, clock: Clock | null, input: PublishInput, start: Checkpoint | null = null, max = 12): Promise<{ checkpoint: Checkpoint; polls: number }> {
  let cp = start;
  for (let i = 0; i < max; i++) {
    const o = await adapter.prepare(ctx, input, cp);
    if (o.kind === 'ready') return { checkpoint: o.checkpoint, polls: i };
    if (o.kind === 'pending') { cp = o.checkpoint; clock?.advance(o.checkAfterMs); continue; }
    throw new Error(`prepare: ${JSON.stringify(o)}`);
  }
  throw new Error('prepare did not settle');
}

export const SCENARIOS: MockScenario[] = ['success', 'processing', 'fail_permanent', 'fail_transient_once', 'rate_limited_once', 'timeout_after_send', 'revoked', 'missing_permission'];

/** No token/secret text may leak into outcomes or messages. */
export function expectNoSecrets(value: unknown, secrets: string[] = [SECRET_ACCESS, SECRET_REFRESH, 'csecret']): void {
  const s = JSON.stringify(value);
  for (const x of secrets) if (s.includes(x)) throw new Error(`secret leaked: ${x}`);
}
