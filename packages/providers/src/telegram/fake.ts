// In-process simulation of the Telegram Bot API endpoints the adapter uses. Serves ONLY simulated
// (mock_) destinations via MockTransport, and test transports. Honours FakeEnv.scenario.
import { createHash } from 'node:crypto';
import { TransportError, type HttpRequest, type HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv, type FakeHandler } from '../transport/mock.js';

export const FAKE_BOT = { id: 7000000001, is_bot: true, first_name: 'Simulated bot', username: 'social_lite_sim_bot' };

const tgErr = (code: number, description: string, parameters?: Record<string, unknown>) =>
  json(code, { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });
const ok = (result: unknown) => json(200, { ok: true, result });

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

async function readParams(req: HttpRequest): Promise<{ params: Record<string, string>; photo: Blob | null; files: Map<string, Blob> }> {
  const params: Record<string, string> = {};
  let photo: Blob | null = null;
  const files = new Map<string, Blob>();
  if (typeof FormData !== 'undefined' && req.body instanceof FormData) {
    for (const [k, v] of req.body.entries()) {
      if (typeof v === 'string') params[k] = v;
      else {
        files.set(k, v);
        if (k === 'photo') photo = v;
      }
    }
  } else if (typeof req.body === 'string' && req.body) {
    const parsed = JSON.parse(req.body) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) params[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return { params, photo, files };
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

function chatFor(ref: string): { id: number | string; type: string; title: string; username?: string } {
  if (/^-?\d+$/.test(ref)) return { id: Number(ref), type: 'channel', title: 'Simulated channel' };
  if (ref.startsWith('mock_')) return { id: ref, type: 'channel', title: 'Simulated channel' };
  const name = ref.replace(/^@/, '');
  const type = /group/i.test(name) ? 'supergroup' : 'channel';
  const id = -1000000000000 - (parseInt(hash(name).slice(0, 8), 16) % 1_000_000_000);
  return { id, type, title: `Simulated ${name}`, username: name };
}

async function onceGate(env: FakeEnv, key: string): Promise<boolean> {
  return (await env.store.incr(`${env.provider}:${env.accountId}:${env.scenario}:${key}`)) === 1;
}

export const telegramFake: FakeHandler = async (req: HttpRequest, env: FakeEnv): Promise<HttpResponse> => {
  const m = new URL(req.url).pathname.match(/^\/bot[^/]+\/([A-Za-z]+)$/);
  if (!m) return json(404, { ok: false, error_code: 404, description: 'Not Found' });
  const method = m[1]!;
  const { params, photo, files } = await readParams(req);
  if (env.scenario === 'revoked') return tgErr(401, 'Unauthorized');

  switch (method) {
    case 'getMe':
      return ok(FAKE_BOT);
    case 'getWebhookInfo':
      return ok({ url: '', has_custom_certificate: false, pending_update_count: 0 });
    case 'getChat': {
      const ref = params.chat_id ?? '';
      if (/notfound/i.test(ref)) return tgErr(400, 'Bad Request: chat not found');
      return ok(chatFor(ref));
    }
    case 'getChatMember': {
      if (env.scenario === 'missing_permission') {
        return ok({ status: 'administrator', user: FAKE_BOT, can_post_messages: false, can_edit_messages: false });
      }
      return ok({ status: 'administrator', user: FAKE_BOT, can_post_messages: true, can_edit_messages: true });
    }
    case 'sendMediaGroup': {
      // V1.1: 2-10 InputMediaPhoto/InputMediaVideo items, uploads referenced as attach://<name>.
      let items: Array<{ type?: string; media?: string; caption?: string }>;
      try { items = JSON.parse(params.media ?? '') as typeof items; } catch { return tgErr(400, 'Bad Request: can\'t parse media JSON object'); }
      if (!Array.isArray(items) || items.length < 2 || items.length > 10) return tgErr(400, 'Bad Request: wrong number of media in the album (must include 2-10 items)');
      for (const it of items) {
        if (it.type !== 'photo' && it.type !== 'video') return tgErr(400, 'Bad Request: unsupported media type in the media group');
        const name = /^attach:\/\/(.+)$/.exec(it.media ?? '')?.[1];
        const f = name ? files.get(name) : undefined;
        if (!f) return tgErr(400, 'Bad Request: wrong file identifier/HTTP URL specified');
        if (f.size > (it.type === 'photo' ? MAX_PHOTO_BYTES : MAX_FILE_BYTES)) return tgErr(400, 'Bad Request: file is too big');
        if ((it.caption ?? '').length > 1024) return tgErr(400, 'Bad Request: message caption is too long');
      }
      if (params.reply_markup) return tgErr(400, 'Bad Request: reply markup is not supported for media groups'); // simulation choice: the method has no such parameter
      const caption = items[0]?.caption ?? '';
      const key = hash(`${params.chat_id}|album|${caption}|${items.length}`);
      switch (env.scenario) {
        case 'missing_permission': return tgErr(400, 'Bad Request: need administrator rights in the channel chat');
        case 'fail_permanent': return tgErr(400, 'Bad Request: PHOTO_INVALID_DIMENSIONS');
        case 'fail_transient_once':
          if (await onceGate(env, key)) throw new TransportError('simulated: connection refused before sending', 'connect', false);
          break;
        case 'rate_limited_once':
          if (await onceGate(env, key)) return tgErr(429, 'Too Many Requests: retry after 3', { retry_after: 3 });
          break;
        default: break;
      }
      const now = env.now();
      const group = env.newId('mock_group_');
      const chat = chatFor(params.chat_id ?? env.accountId);
      const out: Array<Record<string, unknown>> = [];
      for (const [i, it] of items.entries()) {
        const id = env.newId('mock_');
        await env.store.put({
          provider: 'telegram', accountId: env.accountId, objectId: id, kind: 'message', createdAt: now.toISOString(),
          data: { chat_id: params.chat_id, text: i === 0 ? caption : '', media_group_id: group, media_type: it.type, position: i },
        });
        out.push({ message_id: id, date: Math.floor(now.getTime() / 1000), media_group_id: group, chat: { id: chat.id, type: 'channel', title: chat.title }, ...(i === 0 && caption ? { caption } : {}) });
      }
      if (env.scenario === 'timeout_after_send') lostResponse();
      return ok(out);
    }
    case 'sendVideo': {
      const video = files.get('video');
      const text = params.caption ?? '';
      if (!video) return tgErr(400, 'Bad Request: there is no video in the request');
      if (video.size > MAX_FILE_BYTES) return tgErr(400, 'Bad Request: file is too big');
      if (text.length > 1024) return tgErr(400, 'Bad Request: message caption is too long');
      const key = hash(`${params.chat_id}|video|${text}`);
      switch (env.scenario) {
        case 'missing_permission': return tgErr(400, 'Bad Request: need administrator rights in the channel chat');
        case 'fail_permanent': return tgErr(400, 'Bad Request: VIDEO_CONTENT_TYPE_INVALID');
        case 'fail_transient_once':
          if (await onceGate(env, key)) throw new TransportError('simulated: connection refused before sending', 'connect', false);
          break;
        case 'rate_limited_once':
          if (await onceGate(env, key)) return tgErr(429, 'Too Many Requests: retry after 3', { retry_after: 3 });
          break;
        default: break;
      }
      const id = env.newId('mock_');
      const now = env.now();
      await env.store.put({
        provider: 'telegram', accountId: env.accountId, objectId: id, kind: 'message', createdAt: now.toISOString(),
        data: {
          chat_id: params.chat_id, text, has_video: true, video_bytes: video.size, duration: params.duration ? Number(params.duration) : null,
          width: params.width ? Number(params.width) : null, height: params.height ? Number(params.height) : null, supports_streaming: params.supports_streaming === 'true',
          reply_markup: params.reply_markup ? JSON.parse(params.reply_markup) : null,
        },
      });
      if (env.scenario === 'timeout_after_send') lostResponse();
      const chat = chatFor(params.chat_id ?? env.accountId);
      return ok({ message_id: id, date: Math.floor(now.getTime() / 1000), chat: { id: chat.id, type: 'channel', title: chat.title }, caption: text, video: { file_id: `${id}_file`, duration: Number(params.duration ?? 0) } });
    }
    case 'sendMessage':
    case 'sendPhoto': {
      const isPhoto = method === 'sendPhoto';
      const text = (isPhoto ? params.caption : params.text) ?? '';
      if (isPhoto && !photo) return tgErr(400, 'Bad Request: there is no photo in the request');
      if (!isPhoto && !text.trim()) return tgErr(400, 'Bad Request: message text is empty');
      if (!isPhoto && text.length > 4096) return tgErr(400, 'Bad Request: message is too long');
      if (isPhoto && text.length > 1024) return tgErr(400, 'Bad Request: message caption is too long');
      const key = hash(`${params.chat_id}|${text}`);
      switch (env.scenario) {
        case 'missing_permission':
          return tgErr(400, 'Bad Request: need administrator rights in the channel chat');
        case 'fail_permanent':
          return isPhoto ? tgErr(400, 'Bad Request: PHOTO_INVALID_DIMENSIONS') : tgErr(400, 'Bad Request: message is too long');
        case 'fail_transient_once':
          if (await onceGate(env, key)) throw new TransportError('simulated: connection refused before sending', 'connect', false);
          break;
        case 'rate_limited_once':
          if (await onceGate(env, key)) return tgErr(429, 'Too Many Requests: retry after 3', { retry_after: 3 });
          break;
        default:
          break;
      }
      const id = env.newId('mock_');
      const now = env.now();
      await env.store.put({
        provider: 'telegram', accountId: env.accountId, objectId: id, kind: 'message', createdAt: now.toISOString(),
        data: {
          chat_id: params.chat_id, text, has_photo: isPhoto, photo_bytes: photo?.size ?? 0,
          reply_markup: params.reply_markup ? JSON.parse(params.reply_markup) : null,
          link_preview_options: params.link_preview_options ? JSON.parse(params.link_preview_options) : null,
        },
      });
      if (env.scenario === 'timeout_after_send') lostResponse();
      const chat = chatFor(params.chat_id ?? env.accountId);
      return ok({
        message_id: id,
        date: Math.floor(now.getTime() / 1000),
        chat: { id: chat.id, type: 'channel', title: chat.title },
        ...(isPhoto ? { caption: text, photo: [{ file_id: `${id}_file`, width: 1080, height: 1080 }] } : { text }),
      });
    }
    default:
      return tgErr(404, 'Not Found: method not found');
  }
};
