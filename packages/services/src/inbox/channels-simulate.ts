// V3.5 stream B — simulated inbound for SIMULATED channels of the remaining networks (demo, E2E, integration tests).
// Same rules as the foundation simulator: refused in production / with mock providers off; only simulated (mock_)
// channels; rows flagged is_simulated. Each message goes through the REAL path for its network:
//  - webhook networks (Instagram, WhatsApp, Telegram): provider-shaped payload → parser → ingestion (Telegram via the
//    persisted inbound-event store, like a verified webhook);
//  - polling networks (YouTube, Bluesky, Threads, Google reviews): the object is created in the simulated provider API
//    and the channel is polled (cursor + parser + ingestion).
import { randomUUID } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { recordSimulatedInstagram } from '@social-lite/providers/meta/inbox-instagram-fake';
import { recordSimulatedWhatsApp } from '@social-lite/providers/whatsapp/inbox-fake';
import { recordSimulatedTelegramChat } from '@social-lite/providers/telegram/inbox-fake';
import { recordSimulatedYouTubeComment } from '@social-lite/providers/youtube/inbox-fake';
import { recordSimulatedBluesky } from '@social-lite/providers/bluesky/inbox-fake';
import { recordSimulatedThreadsReply } from '@social-lite/providers/threads/inbox-fake';
import { recordSimulatedReview } from '@social-lite/providers/google-business/inbox-fake';
import { getPool, maybeOne } from '@social-lite/db';
import type { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { DbMockStore } from '../mock-store.js';
import { ingestProviderPayload } from './ingest.js';
import { ingestWhatsAppPayload } from './channels-whatsapp.js';
import { processInboundEvents, storeInbound } from './channels-telegram.js';
import { pollChannel } from './channels-poll.js';
import type { ChannelRow } from './shared.js';
import type { simulateSchema } from './simulate.js';

type Input = z.infer<typeof simulateSchema>;
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const NAMES = ['Sam Rivera', 'Priya Shah', 'Lena Novak', 'Tomás Ortega', 'Mei Chen'];

export async function simulateMore(ctx: Ctx, ch: ChannelRow, input: Input): Promise<{ thread: string; external_id: string }> {
  const store = new DbMockStore();
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  const at = new Date(Date.now() - (input.minutes_ago ?? 0) * 60_000);
  const name = input.name ?? NAMES[parseInt(tag.slice(0, 2), 16) % NAMES.length]!;
  const need = (ok: boolean, msg: string) => { if (!ok) throw new AppError('validation_failed', msg); };
  let out: { thread: string; external_id: string };

  switch (ch.kind) {
    case 'instagram': {
      need(input.kind === 'dm' || input.kind === 'comment', 'Instagram supports messages and comments.');
      const ig = ch.external_account_id;
      if (input.kind === 'dm') {
        const igsid = input.thread ?? `mock_igsid_${tag}`;
        const mid = `mock_igm_${tag}`;
        await recordSimulatedInstagram({ store }, ig, { kind: 'dm', mid, igsid, text: input.text, at: at.toISOString() });
        await ingestProviderPayload('instagram', { object: 'instagram', entry: [{ id: ig, time: at.getTime(), messaging: [{ sender: { id: igsid }, recipient: { id: ig }, timestamp: at.getTime(), message: { mid, text: input.text, ...(input.attachment ? { attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=mock' } }] } : {}) } }] }] }, { simulated: true });
        if (input.name) await getPool().query(`UPDATE inbox_contacts SET display_name=$3 WHERE channel_id=$1 AND external_id=$2`, [ch.id, igsid, input.name]);
        out = { thread: igsid, external_id: mid };
      } else {
        const id = `mock_igc_${tag}`;
        const parent = input.thread ?? null;
        await recordSimulatedInstagram({ store }, ig, { kind: 'comment', id, parentId: parent, mediaId: `${ig}_media1`, fromId: `mock_iguser_${tag}`, username: name.toLowerCase().replace(/\W+/g, '.'), text: input.text, at: at.toISOString() });
        await ingestProviderPayload('instagram', { object: 'instagram', entry: [{ id: ig, time: at.getTime(), changes: [{ field: 'comments', value: { id, text: input.text, from: { id: `mock_iguser_${tag}`, username: name.toLowerCase().replace(/\W+/g, '.') }, media: { id: `${ig}_media1` }, ...(parent ? { parent_id: parent } : {}) } }] }] }, { simulated: true });
        out = { thread: parent ?? id, external_id: id };
      }
      break;
    }
    case 'whatsapp': {
      need(input.kind === 'dm', 'WhatsApp supports messages only.');
      const waba = (await maybeOne<{ external_account_id: string }>(getPool(), `SELECT external_account_id FROM integration_connections WHERE id=$1 AND is_simulated`, [ch.integration_id]))?.external_account_id;
      need(!!waba, 'Simulated WhatsApp installation not found.');
      const waId = input.thread && /^\d+$/.test(input.thread) ? input.thread : `44770090${String(parseInt(tag.slice(0, 6), 16) % 10_000).padStart(4, '0')}`;
      const id = `mock_wamid_in_${tag}`;
      const media = input.attachment ? { id: `mock_wamedia_${tag}`, mime: 'image/png', base64: PNG_1PX } : null;
      await recordSimulatedWhatsApp({ store }, waba!, { id, waId, text: input.text, at: at.toISOString(), media });
      await ingestWhatsAppPayload({ object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: ch.external_account_id, display_phone_number: '+44 7700 900123' }, contacts: [{ wa_id: waId, profile: { name } }],
        messages: [media ? { from: waId, id, timestamp: String(Math.floor(at.getTime() / 1000)), type: 'image', image: { id: media.id, mime_type: media.mime, caption: input.text } } : { from: waId, id, timestamp: String(Math.floor(at.getTime() / 1000)), type: 'text', text: { body: input.text } }],
      } }] }] }, true);
      out = { thread: waId, external_id: id };
      break;
    }
    case 'telegram_bot': {
      need(input.kind === 'dm' || input.kind === 'comment', 'Telegram supports private chats and groups.');
      const group = input.kind === 'comment' || input.group === true;
      const chatId = input.thread && /^-?\d+$/.test(input.thread) ? Number(input.thread) : (group ? -1 : 1) * (100_000_000 + (parseInt(tag.slice(0, 7), 16) % 800_000_000));
      await recordSimulatedTelegramChat({ store }, ch.external_account_id, { chatId, type: chatId < 0 ? 'supergroup' : 'private' });
      const n = await store.incr(`tg-inbox:${ch.external_account_id}:inseq`);
      const [first, ...rest] = name.split(' ');
      const update = { update_id: Number(`${Date.now() % 1_000_000_000}${n % 10}`), message: { message_id: n, date: Math.floor(at.getTime() / 1000), chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private', ...(chatId < 0 ? { title: 'Relay Coffee fans' } : {}) },
        from: { id: Math.abs(chatId) + 7, is_bot: false, first_name: first, ...(rest.length ? { last_name: rest.join(' ') } : {}), username: name.toLowerCase().replace(/\W+/g, '_') }, text: input.text,
        ...(input.attachment ? { document: { file_id: `mock_file_${tag}`, file_name: 'receipt.pdf', mime_type: 'application/pdf', file_size: 24 } } : {}) } };
      // Same path as a verified webhook: persisted + deduplicated first, then processed.
      await storeInbound(ch, String(update.update_id), { bot_id: ch.external_account_id, update });
      await processInboundEvents(ch.id);
      out = { thread: String(chatId), external_id: `${chatId}:${n}` };
      break;
    }
    case 'youtube': {
      need(input.kind === 'comment', 'YouTube supports comments.');
      const id = `mock_ytc_in_${tag}`;
      await recordSimulatedYouTubeComment({ store }, ch.external_account_id, { id, parentId: input.thread ?? null, videoId: 'mock_video_1', author: name, text: input.text, at: at.toISOString() });
      await pollChannel(ch.id);
      out = { thread: input.thread ?? id, external_id: id };
      break;
    }
    case 'bluesky': {
      need(input.kind !== 'review', 'Bluesky supports replies, mentions and messages.');
      const authorDid = `did:plc:mock${tag}`;
      if (input.kind === 'dm') {
        const convo = input.thread ?? `mock_convo_${tag}`;
        await recordSimulatedBluesky({ store }, ch.external_account_id, { kind: 'dm', id: `mock_bmsg_in_${tag}`, convoId: convo, authorDid, text: input.text, at: at.toISOString() });
        out = { thread: convo, external_id: `chat:mock_bmsg_in_${tag}` };
      } else {
        await recordSimulatedBluesky({ store }, ch.external_account_id, { kind: input.kind === 'mention' ? 'mention' : 'reply', id: `mock_bnot_${tag}`, authorDid, handle: `${name.toLowerCase().replace(/\W+/g, '')}.bsky.social`, name, text: input.text, at: at.toISOString() });
        out = { thread: `mock_bnot_${tag}`, external_id: `mock_bnot_${tag}` };
      }
      await pollChannel(ch.id);
      break;
    }
    case 'threads': {
      need(input.kind === 'comment', 'Threads supports replies.');
      const id = `mock_thr_in_${tag}`;
      await recordSimulatedThreadsReply({ store }, await accountOf(ch), { id, parentId: input.thread ?? null, username: name.toLowerCase().replace(/\W+/g, '.'), text: input.text, at: at.toISOString() });
      await pollChannel(ch.id);
      out = { thread: input.thread ?? id, external_id: id };
      break;
    }
    case 'google_business_profile': {
      need(input.kind === 'review', 'Google Business Profile supports reviews.');
      const account = await accountOf(ch);
      const id = `mock_rev_${tag}`;
      await recordSimulatedReview({ store }, account, { id, location: ch.external_account_id, reviewer: name, rating: input.rating ?? 4, comment: input.text, at: at.toISOString() });
      await pollChannel(ch.id);
      out = { thread: `review:${id}`, external_id: `review:${id}` };
      break;
    }
    default:
      throw new AppError('invalid_state', 'This network has no simulated inbox.');
  }
  await audit(getPool(), { workspaceId: ch.workspace_id, brandId: ch.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.simulated_message', resourceType: 'inbox_channel', resourceId: ch.id, diff: { kind: input.kind, network: ch.kind }, correlationId: ctx.correlationId });
  return out;
}

/** Simulated account id behind a channel (the connection's or the integration's mock_ id). */
async function accountOf(ch: ChannelRow): Promise<string> {
  const r = ch.connection_id
    ? await maybeOne<{ id: string }>(getPool(), `SELECT provider_account_id AS id FROM connections WHERE id=$1 AND is_mock`, [ch.connection_id])
    : await maybeOne<{ id: string }>(getPool(), `SELECT external_account_id AS id FROM integration_connections WHERE id=$1 AND is_simulated`, [ch.integration_id]);
  if (!r?.id.startsWith('mock_')) throw new AppError('invalid_state', 'Only simulated channels accept simulated messages.');
  return r.id;
}
