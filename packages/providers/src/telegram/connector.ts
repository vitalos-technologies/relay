// Telegram channel connection (AC-03): verify bot identity, resolve the channel, confirm the bot
// may post. Outbound-only: NEVER calls setWebhook / deleteWebhook / getUpdates, so an existing bot
// integration (webhook or long polling) keeps its update stream. getWebhookInfo is read only to
// report that an existing webhook was preserved.
import { TransportError, type AdapterContext, type FinalizedDestination, type TelegramConnector } from '@social-lite/core';
import { BOT_TOKEN_RE, TelegramApiError, classifyTelegramError, tgCall, type TgChat, type TgChatMember, type TgUser, type TgWebhookInfo } from './api.js';
import { evaluateMember } from './adapter.js';

/** A setup problem with a safe, user-facing message. Never contains the bot token. */
export class TelegramSetupError extends Error {
  constructor(public readonly code: string, message: string, public readonly field: 'bot_token' | 'channel' | null = null) {
    super(message);
    this.name = 'TelegramSetupError';
  }
}

/**
 * Normalise user input into a chat_id: "@name" or numeric "-100…". Accepts public t.me/<name>
 * links and bare usernames for convenience. Invite links (t.me/+…, t.me/joinchat/…) are rejected:
 * they do not identify a channel to the Bot API.
 */
export function parseChannelInput(raw: string): string {
  const s = raw.trim();
  if (!s) throw new TelegramSetupError('channel_required', 'Enter the channel as @username or its numeric ID (-100…).', 'channel');
  if (/^(https?:\/\/)?(t\.me|telegram\.me)\/(\+|joinchat\/)/i.test(s) || /^\+[A-Za-z0-9_-]{10,}$/.test(s)) {
    throw new TelegramSetupError('invite_link', 'Invite links cannot be used to identify a channel. Use the public @username, or for a private channel add the bot as an administrator and enter the numeric channel ID (it starts with -100).', 'channel');
  }
  if (/^-100\d{5,}$/.test(s)) return s;
  if (/^-?\d+$/.test(s)) throw new TelegramSetupError('not_channel_id', 'Channel IDs start with -100 (for example -1001234567890). Group or user IDs cannot be used.', 'channel');
  const link = s.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i);
  if (link) return `@${link[1]}`;
  const name = s.replace(/^@/, '');
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) return `@${name}`;
  throw new TelegramSetupError('channel_invalid', 'Enter the channel as @username or its numeric ID (-100…).', 'channel');
}

async function verify(ctx: AdapterContext, p: { botToken: string; channel: string }): Promise<FinalizedDestination> {
  const token = p.botToken.trim();
  if (!BOT_TOKEN_RE.test(token)) {
    throw new TelegramSetupError('token_format', 'That does not look like a bot token. Copy the full token from @BotFather (it looks like 123456789:AA…).', 'bot_token');
  }
  const chatRef = parseChannelInput(p.channel);

  let bot: TgUser;
  try {
    bot = await tgCall<TgUser>(ctx, token, 'getMe', {});
  } catch (err) {
    if (err instanceof TelegramApiError && classifyTelegramError(err).kind === 'reconnect') {
      throw new TelegramSetupError('token_rejected', 'Telegram rejected this bot token. Copy the current token from @BotFather (/mybots → API Token).', 'bot_token');
    }
    throw err;
  }
  if (!bot.is_bot) throw new TelegramSetupError('not_bot', 'This token does not belong to a bot.', 'bot_token');

  let chat: TgChat;
  try {
    chat = await tgCall<TgChat>(ctx, token, 'getChat', { chat_id: chatRef });
  } catch (err) {
    if (err instanceof TelegramApiError && err.status !== 429 && err.status < 500) {
      throw new TelegramSetupError('channel_not_found',
        `Telegram could not find that channel for @${bot.username ?? 'your bot'}. Check the @username, or for a private channel add the bot as an administrator first and use the numeric ID (-100…).`, 'channel');
    }
    throw err;
  }
  if (chat.type !== 'channel') {
    throw new TelegramSetupError('not_channel', `That chat is a ${chat.type}, not a channel. Only channels are supported.`, 'channel');
  }

  const checkedAt = ctx.now().toISOString();
  let health;
  try {
    const member = await tgCall<TgChatMember>(ctx, token, 'getChatMember', { chat_id: chat.id, user_id: bot.id });
    health = evaluateMember(member, bot, checkedAt);
  } catch (err) {
    if (err instanceof TelegramApiError && err.status !== 429 && err.status < 500) {
      health = evaluateMember({ status: 'left' }, bot, checkedAt);
    } else {
      throw err;
    }
  }

  // Read-only: report whether the bot already has a webhook, which we leave untouched.
  let webhookPreserved = false;
  try {
    const wh = await tgCall<TgWebhookInfo>(ctx, token, 'getWebhookInfo', {});
    webhookPreserved = !!wh.url;
  } catch (err) {
    if (err instanceof TransportError) throw err;
    // non-essential
  }

  return {
    providerAccountId: String(chat.id),
    displayName: chat.title ?? (chat.username ? `@${chat.username}` : String(chat.id)),
    username: chat.username ?? null,
    credentials: { kind: 'telegram_bot', botToken: token },
    grantedScopes: health.status === 'ready' ? ['can_post_messages'] : [],
    expiresAt: null,
    metadata: {
      bot_id: String(bot.id),
      bot_username: bot.username ?? null,
      chat_type: chat.type,
      existing_webhook_preserved: webhookPreserved,
      webhook_note: webhookPreserved
        ? 'This bot already has a webhook. Relay only sends messages and left the existing webhook unchanged.'
        : 'Relay only sends messages; it does not read or change the bot\'s updates.',
    },
    health,
  };
}

export const telegramConnector: TelegramConnector = { provider: 'telegram', verify };
