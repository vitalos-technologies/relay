// Simulated Bot API inbox endpoints for SIMULATED (mock_) bots — V3.5 stream B. Reached through the inbox mock transport
// before the publishing fake. Webhook ownership is simulated per bot (getWebhookInfo/setWebhook/deleteWebhook) so the
// "never overwrite an existing webhook" rule is exercised; recordSimulatedTelegramWebhook() simulates another app owning it.
import type { HttpRequest, HttpResponse } from '@social-lite/core';
import { json, lostResponse, type FakeEnv } from '../transport/mock.js';

const P = 'telegram' as const;
const tgErr = (code: number, description: string, parameters?: Record<string, unknown>) => json(code, { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });
const ok = (result: unknown) => json(200, { ok: true, result });
const once = async (env: FakeEnv, k: string) => (await env.store.incr(`tg-inbox:${env.accountId}:${k}:${env.scenario}`)) === 1;
const hookId = (bot: string) => `mock_webhook_${bot.replace(/^mock_/, '')}`.slice(0, 120);

export async function telegramInboxFake(req: HttpRequest, env: FakeEnv): Promise<HttpResponse | null> {
  const m = new URL(req.url).pathname.match(/^\/bot[^/]+\/([A-Za-z]+)$/);
  if (!m) return null;
  const method = m[1]!;
  const p = (typeof req.body === 'string' && req.body ? JSON.parse(req.body) : {}) as Record<string, unknown>;
  if (env.scenario === 'revoked') return tgErr(401, 'Unauthorized');
  const bot = env.accountId;
  switch (method) {
    case 'getWebhookInfo': {
      const h = await env.store.get(P, hookId(bot));
      return ok({ url: String(h?.data.url ?? ''), has_custom_certificate: false, pending_update_count: Number(h?.data.pending ?? 0) });
    }
    case 'setWebhook': {
      const url = String(p.url ?? '');
      if (!/^https:\/\//.test(url) && !/^http:\/\/localhost/.test(url)) return tgErr(400, 'Bad Request: bad webhook: An HTTPS URL must be provided for webhook');
      if (p.secret_token !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(String(p.secret_token))) return tgErr(400, 'Bad Request: secret token contains unallowed characters');
      await env.store.put({ provider: P, accountId: bot, objectId: hookId(bot), kind: 'tg_webhook', createdAt: env.now().toISOString(), data: { url, secret_set: !!p.secret_token, allowed: p.allowed_updates ?? null } });
      return ok(true);
    }
    case 'deleteWebhook': {
      await env.store.put({ provider: P, accountId: bot, objectId: hookId(bot), kind: 'tg_webhook', createdAt: env.now().toISOString(), data: { url: '' } });
      return ok(true);
    }
    case 'sendMessage': {
      if (p.reply_parameters === undefined && !(await env.store.list(P, bot, 'tg_chat')).some((o) => String(o.data.chat_id) === String(p.chat_id))) return null;   // publishing (channel) path
      const chat = (await env.store.list(P, bot, 'tg_chat')).find((o) => String(o.data.chat_id) === String(p.chat_id));
      if (!chat) return tgErr(400, 'Bad Request: chat not found');
      const text = String(p.text ?? '');
      if (!text) return tgErr(400, 'Bad Request: message text is empty');
      if (text.length > 4096) return tgErr(400, 'Bad Request: message is too long');
      if (chat.data.blocked) return tgErr(403, 'Forbidden: bot was blocked by the user');
      if (env.scenario === 'fail_permanent') return tgErr(400, 'Bad Request: can\'t parse entities');
      if (env.scenario === 'rate_limited_once' && await once(env, 'rate')) return tgErr(429, 'Too Many Requests: retry after 2', { retry_after: 2 });
      const n = (await env.store.incr(`tg-inbox:${bot}:msgseq`)) + 1000;
      await env.store.put({ provider: P, accountId: bot, objectId: `mock_tgout_${bot.slice(5, 40)}_${n}`, kind: 'tg_out', createdAt: env.now().toISOString(), data: { chat_id: p.chat_id, message_id: n, text, at: env.now().toISOString(), deleted: false } });
      if (env.scenario === 'timeout_after_send' && await once(env, 'timeout')) lostResponse();
      return ok({ message_id: n, date: Math.floor(env.now().getTime() / 1000), chat: { id: chat.data.chat_id, type: chat.data.type }, text });
    }
    case 'deleteMessage': {
      const out = (await env.store.list(P, bot, 'tg_out')).find((o) => String(o.data.chat_id) === String(p.chat_id) && Number(o.data.message_id) === Number(p.message_id));
      if (!out) return tgErr(400, 'Bad Request: message can\'t be deleted for everyone');
      await env.store.put({ ...out, data: { ...out.data, deleted: true } });
      return ok(true);
    }
    case 'getFile':
      return ok({ file_id: p.file_id, file_unique_id: 'mock', file_size: 24, file_path: 'documents/file_0.txt', data_base64: Buffer.from('simulated telegram file').toString('base64') });
    default:
      return null;
  }
}

/** Simulated chat the bot can see (private chat or group) — simulator only. */
export async function recordSimulatedTelegramChat(env: Pick<FakeEnv, 'store'>, bot: string, chat: { chatId: number; type: 'private' | 'group' | 'supergroup'; blocked?: boolean }): Promise<void> {
  if (!bot.startsWith('mock_')) throw new Error('simulated chats are only for mock_ bots');
  await env.store.put({ provider: P, accountId: bot, objectId: `mock_tgchat_${bot.slice(5, 40)}_${Math.abs(chat.chatId)}`, kind: 'tg_chat', createdAt: new Date().toISOString(), data: { chat_id: chat.chatId, type: chat.type, blocked: !!chat.blocked } });
}

/** Simulate ANOTHER application owning the bot's webhook (tests the never-overwrite rule). */
export async function recordSimulatedTelegramWebhook(env: Pick<FakeEnv, 'store'>, bot: string, url: string): Promise<void> {
  await env.store.put({ provider: P, accountId: bot, objectId: hookId(bot), kind: 'tg_webhook', createdAt: new Date().toISOString(), data: { url } });
}

export async function simulatedTelegramSent(env: Pick<FakeEnv, 'store'>, bot: string): Promise<Array<{ chatId: string; messageId: number; text: string; deleted: boolean }>> {
  return (await env.store.list(P, bot, 'tg_out')).map((o) => ({ chatId: String(o.data.chat_id), messageId: Number(o.data.message_id), text: String(o.data.text), deleted: !!o.data.deleted }));
}
