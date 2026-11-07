// Telegram adapter/connector contract: exact outgoing Bot API requests, error classification,
// simulated-API scenarios, and token hygiene. No network.
import { describe, expect, it } from 'vitest';
import { TransportError, type AdapterContext, type HttpRequest, type HttpResponse, type PublishConnection, type PublishInput, type PublishMedia, type Transport } from '@social-lite/core';
import { MemoryMockStore, MockTransport, type MockScenario } from '@social-lite/providers';
import { telegramAdapter, telegramConnector, telegramFake } from '../../packages/providers/src/telegram/index.js';
import { TelegramSetupError, parseChannelInput } from '../../packages/providers/src/telegram/connector.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

type Responder = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
class RecordingTransport implements Transport {
  readonly mode = 'live' as const;
  readonly requests: HttpRequest[] = [];
  constructor(private readonly respond: Responder) {}
  async send(req: HttpRequest) { this.requests.push(req); return this.respond(req); }
}
const tg = (result: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true, result }) });
const tgErr = (code: number, description: string, parameters?: object): HttpResponse =>
  ({ status: code, headers: {}, body: JSON.stringify({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }) });
const method = (r: HttpRequest) => r.url.split('/').pop();
const ctxWith = (transport: Transport): AdapterContext => ({ transport, now: () => new Date('2026-11-06T12:00:00Z'), config: {} });

const conn: PublishConnection = { id: 'c1', provider: 'telegram', providerAccountId: '-1001234567890', displayName: 'News', username: 'newschan', metadata: {}, isMock: false };
const image: PublishMedia = { assetId: 'a1', mime: 'image/jpeg', width: 1080, height: 1080, bytes: 4, url: 'https://storage.invalid/a1', load: async () => new Uint8Array([1, 2, 3, 4]) };

function input(over: Partial<PublishInput['variant']> = {}, media: PublishMedia[] = [], connection = conn, token = TOKEN): PublishInput {
  return {
    deliveryId: 'd1', attemptNumber: 1, idempotencyKey: 'k1', connection,
    credentials: connection.isMock ? { kind: 'mock', token } : { kind: 'telegram_bot', botToken: token },
    variant: { text: 'Hello channel', link: null, format: media.length ? 'image' : 'text', buttons: [], options: {}, ...over },
    media,
  };
}

describe('telegram publish: exact requests', () => {
  it('sendMessage: token only in the path, link appended + preview, URL buttons as inline_keyboard rows', async () => {
    const t = new RecordingTransport(() => tg({ message_id: 42, date: 1_790_000_000 }));
    const out = await telegramAdapter.publish(ctxWith(t), input({
      link: 'https://example.com/a', buttons: [{ text: 'Read', url: 'https://example.com/a' }, { text: 'Shop', url: 'https://shop.example.com' }],
    }), null);
    expect(t.requests).toHaveLength(1);
    const r = t.requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(r.publishes).toBe(true);
    expect(r.op).toBe('telegram.sendMessage');
    expect(r.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(r.body as string)).toEqual({
      chat_id: '-1001234567890',
      text: 'Hello channel\n\nhttps://example.com/a',
      link_preview_options: { is_disabled: false, url: 'https://example.com/a' },
      reply_markup: { inline_keyboard: [[{ text: 'Read', url: 'https://example.com/a' }], [{ text: 'Shop', url: 'https://shop.example.com' }]] },
    });
    expect(String(r.body)).not.toContain(TOKEN);
    expect(out).toEqual({ kind: 'confirmed', providerIds: ['42'], url: 'https://t.me/newschan/42', publishedAt: new Date(1_790_000_000_000).toISOString() });
  });

  it('sendMessage without link/buttons sends neither field; no public username => no url', async () => {
    const t = new RecordingTransport(() => tg({ message_id: 7 }));
    const out = await telegramAdapter.publish(ctxWith(t), input({}, [], { ...conn, username: null }), null);
    expect(JSON.parse(t.requests[0]!.body as string)).toEqual({ chat_id: '-1001234567890', text: 'Hello channel' });
    expect(out).toMatchObject({ kind: 'confirmed', providerIds: ['7'], url: null });
  });

  it('sendPhoto: multipart with photo bytes, caption (link appended) and reply_markup JSON', async () => {
    const t = new RecordingTransport(() => tg({ message_id: 43 }));
    const out = await telegramAdapter.publish(ctxWith(t), input({ text: 'Look', link: 'https://example.com/p', buttons: [{ text: 'Open', url: 'https://example.com/p' }] }, [image]), null);
    const r = t.requests[0]!;
    expect(r.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendPhoto`);
    expect(r.body).toBeInstanceOf(FormData);
    expect(r.headers?.['content-type']).toBeUndefined(); // fetch sets the multipart boundary
    const f = r.body as FormData;
    expect([...f.keys()].sort()).toEqual(['caption', 'chat_id', 'photo', 'reply_markup']);
    expect(f.get('chat_id')).toBe('-1001234567890');
    expect(f.get('caption')).toBe('Look\n\nhttps://example.com/p');
    expect(JSON.parse(f.get('reply_markup') as string)).toEqual({ inline_keyboard: [[{ text: 'Open', url: 'https://example.com/p' }]] });
    const photo = f.get('photo') as File;
    expect(photo.type).toBe('image/jpeg');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(out).toMatchObject({ kind: 'confirmed', providerIds: ['43'], url: 'https://t.me/newschan/43' });
  });

  it('prepare is a no-op ready step', async () => {
    const t = new RecordingTransport(() => tg({}));
    expect(await telegramAdapter.prepare(ctxWith(t), input(), null)).toEqual({ kind: 'ready', checkpoint: { step: 'none', data: {} } });
    expect(t.requests).toHaveLength(0);
  });
});

describe('telegram publish: error classification', () => {
  const cases: Array<[string, () => HttpResponse | never, Record<string, unknown>]> = [
    ['429 flood control', () => tgErr(429, 'Too Many Requests: retry after 7', { retry_after: 7 }), { kind: 'rejected_safe_to_retry', code: 'rate_limited', retryAfterMs: 7000 }],
    ['401 token revoked', () => tgErr(401, 'Unauthorized'), { kind: 'permanent_failure', blocking: 'reconnect' }],
    ['403 bot kicked', () => tgErr(403, 'Forbidden: bot was kicked from the channel chat'), { kind: 'permanent_failure', blocking: 'permission', code: 'telegram_not_in_channel' }],
    ['400 not enough rights', () => tgErr(400, 'Bad Request: not enough rights to send text messages to the chat'), { kind: 'permanent_failure', blocking: 'permission' }],
    ['400 need admin rights', () => tgErr(400, 'Bad Request: need administrator rights in the channel chat'), { kind: 'permanent_failure', blocking: 'permission' }],
    ['400 chat not found', () => tgErr(400, 'Bad Request: chat not found'), { kind: 'permanent_failure', blocking: 'permission' }],
    ['400 caption too long', () => tgErr(400, 'Bad Request: message caption is too long'), { kind: 'permanent_failure', code: 'caption_too_long' }],
    ['400 bad button', () => tgErr(400, 'Bad Request: BUTTON_URL_INVALID'), { kind: 'permanent_failure', code: 'button_rejected' }],
    ['400 other', () => tgErr(400, 'Bad Request: something odd'), { kind: 'permanent_failure', code: 'telegram_bad_request' }],
    ['502 after send', () => tgErr(502, 'Bad Gateway'), { kind: 'unknown' }],
    ['pre-connect failure', () => { throw new TransportError('connection failed (ECONNREFUSED)', 'connect', false); }, { kind: 'rejected_safe_to_retry', code: 'network_unreachable' }],
    ['timeout after send', () => { throw new TransportError('request timed out', 'timeout', true); }, { kind: 'unknown', code: 'response_lost' }],
  ];
  it.each(cases)('%s', async (_name, respond, expected) => {
    const t = new RecordingTransport(respond);
    const out = await telegramAdapter.publish(ctxWith(t), input(), null);
    expect(out).toMatchObject(expected);
    if (out.kind === 'permanent_failure' && !('blocking' in expected)) expect(out.blocking).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('never leaks the token even if Telegram echoes it in a description', async () => {
    const t = new RecordingTransport(() => tgErr(400, `Bad Request: weird ${TOKEN} thing`));
    const out = await telegramAdapter.publish(ctxWith(t), input(), null);
    expect(out.kind).toBe('permanent_failure');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
  });

  it('reconcile without ids is unsupported (no history lookup, no idempotency key)', async () => {
    const t = new RecordingTransport(() => tg({}));
    const r = await telegramAdapter.reconcile(ctxWith(t), { deliveryId: 'd', connection: conn, credentials: { kind: 'telegram_bot', botToken: TOKEN }, variantText: 'x', providerIds: [], checkpoint: null, sentAt: null });
    expect(r.kind).toBe('unsupported');
    expect(t.requests).toHaveLength(0);
    const r2 = await telegramAdapter.reconcile(ctxWith(t), { deliveryId: 'd', connection: conn, credentials: { kind: 'telegram_bot', botToken: TOKEN }, variantText: 'x', providerIds: ['9'], checkpoint: null, sentAt: null });
    expect(r2).toEqual({ kind: 'published', providerIds: ['9'], url: 'https://t.me/newschan/9' });
  });
});

describe('telegram validation', () => {
  it('counts limits: 4096 text, 1024 caption, width+height <= 10000, one image, buttons need https', () => {
    const v = (variant: Partial<PublishInput['variant']>, media: PublishMedia[] = []) => telegramAdapter.validate({ connection: conn, media, variant: { text: '', link: null, format: 'text', buttons: [], options: {}, ...variant } });
    expect(v({ text: 'a'.repeat(4096) }).ok).toBe(true);
    expect(v({ text: 'a'.repeat(4097) }).issues[0]?.code).toBe('too_long');
    expect(v({ text: 'a'.repeat(1025) }, [image]).issues[0]?.code).toBe('too_long');
    expect(v({ text: 'ok' }, [{ ...image, width: 9000, height: 1500 }]).issues.map((i) => i.code)).toContain('dimensions');
    // V1.1: albums of 2-10 items are supported (tests/contracts/telegram-media.test.ts); 11 is too many.
    expect(v({ text: 'ok' }, Array.from({ length: 11 }, (_, i) => ({ ...image, assetId: `a${i}` }))).issues.map((i) => i.code)).toContain('too_many_images');
    expect(v({ text: 'ok', buttons: [{ text: 'x', url: 'http://insecure' }] }).issues.map((i) => i.code)).toContain('button_url');
  });
});

describe('telegram connector verify', () => {
  const bot = { id: 555, is_bot: true, first_name: 'Poster', username: 'poster_bot' };
  function responder(member: object, chat: object = { id: -1001234567890, type: 'channel', title: 'News', username: 'newschan' }, webhook = 'https://other.example/hook'): Responder {
    return (r) => {
      switch (method(r)) {
        case 'getMe': return tg(bot);
        case 'getChat': return tg(chat);
        case 'getChatMember': return tg(member);
        case 'getWebhookInfo': return tg({ url: webhook, pending_update_count: 0 });
        default: throw new Error(`unexpected method ${method(r)}`);
      }
    };
  }

  it('verifies bot, channel and post right; never touches webhooks/updates; preserves existing webhook', async () => {
    const t = new RecordingTransport(responder({ status: 'administrator', can_post_messages: true, user: bot }));
    const d = await telegramConnector.verify(ctxWith(t), { botToken: TOKEN, channel: '@newschan' });
    expect(t.requests.map(method)).toEqual(['getMe', 'getChat', 'getChatMember', 'getWebhookInfo']);
    expect(t.requests.map(method)).not.toEqual(expect.arrayContaining(['setWebhook', 'deleteWebhook', 'getUpdates']));
    expect(JSON.parse(t.requests[1]!.body as string)).toEqual({ chat_id: '@newschan' });
    expect(JSON.parse(t.requests[2]!.body as string)).toEqual({ chat_id: -1001234567890, user_id: 555 });
    expect(d).toMatchObject({
      providerAccountId: '-1001234567890', displayName: 'News', username: 'newschan',
      credentials: { kind: 'telegram_bot', botToken: TOKEN }, health: { status: 'ready' },
      metadata: { bot_id: '555', bot_username: 'poster_bot', existing_webhook_preserved: true },
    });
  });

  it('administrator without Post Messages => missing_permission with the exact fix', async () => {
    const t = new RecordingTransport(responder({ status: 'administrator', can_post_messages: false, user: bot }));
    const d = await telegramConnector.verify(ctxWith(t), { botToken: TOKEN, channel: '-1001234567890' });
    expect(d.health.status).toBe('missing_permission');
    expect(d.health.missingPermissions).toEqual(['can_post_messages']);
    expect(d.health.message).toContain('Post Messages');
  });

  it('not an administrator => missing_permission; creator => ready', async () => {
    const t1 = new RecordingTransport(responder({ status: 'left', user: bot }));
    expect((await telegramConnector.verify(ctxWith(t1), { botToken: TOKEN, channel: '@newschan' })).health).toMatchObject({ status: 'missing_permission', missingPermissions: ['administrator', 'can_post_messages'] });
    const t2 = new RecordingTransport(responder({ status: 'creator', user: bot }));
    expect((await telegramConnector.verify(ctxWith(t2), { botToken: TOKEN, channel: '@newschan' })).health.status).toBe('ready');
  });

  it('rejects groups, invite links, bad tokens — without echoing the token', async () => {
    const t = new RecordingTransport(responder({ status: 'administrator', can_post_messages: true }, { id: -100555, type: 'supergroup', title: 'G' }));
    await expect(telegramConnector.verify(ctxWith(t), { botToken: TOKEN, channel: '@somegroup' })).rejects.toMatchObject({ code: 'not_channel' });
    expect(() => parseChannelInput('https://t.me/+AbCdEfGhIjKlMnOp')).toThrow(/Invite links/);
    expect(() => parseChannelInput('t.me/joinchat/AAAAAEtest')).toThrow(TelegramSetupError);
    expect(parseChannelInput('https://t.me/newschan')).toBe('@newschan');
    expect(parseChannelInput('newschan')).toBe('@newschan');
    expect(parseChannelInput('-1001234567890')).toBe('-1001234567890');
    expect(() => parseChannelInput('12345')).toThrow(/-100/);
    const t401 = new RecordingTransport(() => tgErr(401, 'Unauthorized'));
    const err = await telegramConnector.verify(ctxWith(t401), { botToken: TOKEN, channel: '@newschan' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(TelegramSetupError);
    expect((err as Error).message).not.toContain(TOKEN);
    await expect(telegramConnector.verify(ctxWith(t401), { botToken: 'not-a-token', channel: '@x' })).rejects.toMatchObject({ code: 'token_format', field: 'bot_token' });
    const t404 = new RecordingTransport((r) => (method(r) === 'getMe' ? tg(bot) : tgErr(400, 'Bad Request: chat not found')));
    await expect(telegramConnector.verify(ctxWith(t404), { botToken: TOKEN, channel: '@missing' })).rejects.toMatchObject({ code: 'channel_not_found', field: 'channel' });
  });

  it('health = getMe + getChatMember; revoked token => reconnect_required', async () => {
    const t = new RecordingTransport(responder({ status: 'administrator', can_post_messages: true, user: bot }));
    const h = await telegramAdapter.health(ctxWith(t), conn, { kind: 'telegram_bot', botToken: TOKEN });
    expect(t.requests.map(method)).toEqual(['getMe', 'getChatMember']);
    expect(h.status).toBe('ready');
    const t401 = new RecordingTransport(() => tgErr(401, 'Unauthorized'));
    expect((await telegramAdapter.health(ctxWith(t401), conn, { kind: 'telegram_bot', botToken: TOKEN })).status).toBe('reconnect_required');
  });
});

describe('telegram simulated API (fake) scenarios through prepare -> publish', () => {
  const mockConn = { ...conn, providerAccountId: 'mock_telegram_abc', isMock: true, username: null };
  async function run(scenario: MockScenario, media: PublishMedia[] = []) {
    const store = new MemoryMockStore();
    const ctx = ctxWith(new MockTransport(telegramFake, { provider: 'telegram', accountId: 'mock_telegram_abc', scenario, store }));
    const inp = input({ text: `post for ${scenario}` }, media, mockConn, 'mock-token');
    const prep = await telegramAdapter.prepare(ctx, inp, null);
    expect(prep.kind).toBe('ready');
    const first = await telegramAdapter.publish(ctx, inp, prep.kind === 'ready' ? prep.checkpoint : null);
    const second = await telegramAdapter.publish(ctx, inp, null);
    return { first, second, store };
  }

  it('success: mock_ ids, no URL (simulated)', async () => {
    const { first } = await run('success', [image]);
    expect(first).toMatchObject({ kind: 'confirmed', url: null });
    expect((first as { providerIds: string[] }).providerIds[0]).toMatch(/^mock_/);
  });
  it('fail_permanent', async () => {
    const { first } = await run('fail_permanent');
    expect(first.kind).toBe('permanent_failure');
    expect((first as { blocking?: string }).blocking).toBeUndefined();
  });
  it('fail_transient_once => safe retry then success', async () => {
    const r = await run('fail_transient_once');
    expect(r.first.kind).toBe('rejected_safe_to_retry');
    expect(r.second.kind).toBe('confirmed');
  });
  it('rate_limited_once => retry_after honoured then success', async () => {
    const r = await run('rate_limited_once');
    expect(r.first).toMatchObject({ kind: 'rejected_safe_to_retry', retryAfterMs: 3000 });
    expect(r.second.kind).toBe('confirmed');
  });
  it('timeout_after_send => unknown, but the message exists; reconcile is unsupported', async () => {
    const r = await run('timeout_after_send');
    expect(r.first.kind).toBe('unknown');
    expect(await r.store.list('telegram', 'mock_telegram_abc', 'message')).not.toHaveLength(0);
  });
  it('processing behaves as success (Telegram has no async processing)', async () => expect((await run('processing', [image])).first.kind).toBe('confirmed'));
  it('revoked => reconnect', async () => expect((await run('revoked')).first).toMatchObject({ kind: 'permanent_failure', blocking: 'reconnect' }));
  it('missing_permission => permission', async () => expect((await run('missing_permission')).first).toMatchObject({ kind: 'permanent_failure', blocking: 'permission' }));
});
