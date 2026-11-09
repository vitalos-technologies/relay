// V3.5 stream B — pure parsers, reply rules and charge rules of the remaining inbox networks.
import { describe, expect, it } from 'vitest';
import { instagramReplyRules, parseInstagramWebhook } from '@social-lite/providers/meta/inbox-instagram';
import { parseWhatsAppWebhook, whatsAppCharge, whatsAppReplyRules, whatsAppStatuses } from '@social-lite/providers/whatsapp/inbox';
import { parseTelegramWebhook, telegramReplyRules } from '@social-lite/providers/telegram/inbox';
import { gbpReplyRules, reviewItems } from '@social-lite/providers/google-business/inbox';
import { bskyItems, blueskyReplyRules } from '@social-lite/providers/bluesky/inbox';
import { youtubeReplyRules } from '@social-lite/providers/youtube/inbox';
import { threadsReplyRules } from '@social-lite/providers/threads/inbox';
import { getInboxAdapter, implementedChannelKinds } from '@social-lite/providers';

const now = new Date('2026-11-08T12:00:00Z');
const H = 3600_000;
const rules = (kind: 'dm' | 'comment' | 'review' | 'mention', mode: 'public_reply' | 'private_message', last: number | null, used = false) =>
  ({ kind, mode, now, lastInboundAt: last === null ? null : new Date(now.getTime() - last), firstInboundAt: null, privateReplyUsed: used, features: [] as string[] });

describe('stream B parsers', () => {
  it('Instagram: DMs, echoes, comments (top + nested), deletions; other objects ignored', () => {
    const items = parseInstagramWebhook({ object: 'instagram', entry: [{ id: 'ig1', time: 1_700_000_000, messaging: [
      { sender: { id: 'u1' }, recipient: { id: 'ig1' }, timestamp: 1_700_000_000_000, message: { mid: 'm1', text: 'hi', attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/x' } }] } },
      { sender: { id: 'ig1' }, recipient: { id: 'u1' }, timestamp: 1_700_000_001_000, message: { mid: 'm2', text: 'hello', is_echo: true } },
      { sender: { id: 'u1' }, recipient: { id: 'ig1' }, timestamp: 1_700_000_002_000, message: { mid: 'm1', is_deleted: true } },
    ], changes: [{ field: 'comments', value: { id: 'c2', parent_id: 'c1', text: 'reply', from: { id: 'u2', username: 'dee' }, media: { id: 'p1' } } }] }] });
    expect(items.map((i) => i.type)).toEqual(['message', 'message', 'delete', 'message']);
    expect(items[0]).toMatchObject({ threadKey: 'igsid:u1', direction: 'inbound', attachments: [{ providerRef: 'url:https://lookaside.fbsbx.com/x' }] });
    expect(items[1]).toMatchObject({ direction: 'outbound', threadKey: 'igsid:u1' });
    expect(items[3]).toMatchObject({ conversationKind: 'comment', threadKey: 'comment:c1', parentExternalId: 'c1', author: { handle: 'dee' } });
    expect(parseInstagramWebhook({ object: 'page', entry: [] })).toEqual([]);
  });

  it('WhatsApp: text + media messages, receipts by id, statuses with pricing', () => {
    const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn1' }, contacts: [{ wa_id: '447', profile: { name: 'Lia' } }],
      messages: [{ from: '447', id: 'w1', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }, { from: '447', id: 'w2', timestamp: '1700000001', type: 'image', image: { id: 'med1', caption: 'photo' } }],
      statuses: [{ id: 'w9', status: 'read', timestamp: '1', recipient_id: '447', pricing: { billable: false, category: 'service' } }, { id: 'w8', status: 'failed', recipient_id: '447', errors: [{ code: 131026, title: 'Undeliverable' }] }] } }] }] };
    const items = parseWhatsAppWebhook(body);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ accountId: 'pn1', threadKey: 'wa:447', author: { name: 'Lia', handle: '+447' }, text: 'hi' });
    expect(items[1]).toMatchObject({ text: 'photo', attachments: [{ type: 'image', providerRef: 'media:med1' }] });
    expect(items[2]).toMatchObject({ type: 'receipt', kind: 'read', externalIds: ['w9'] });
    expect(whatsAppStatuses(body).map((s) => s.status)).toEqual(['read', 'failed']);
  });

  it('Telegram: private + group messages, edits; bots and channel posts ignored', () => {
    const p = (u: unknown) => parseTelegramWebhook({ bot_id: 'b1', update: u });
    expect(p({ update_id: 1, message: { message_id: 5, date: 1_700_000_000, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Tia' }, text: 'hey' } })[0]).toMatchObject({ conversationKind: 'dm', threadKey: 'chat:42', externalId: '42:5', author: { name: 'Tia' } });
    expect(p({ update_id: 2, message: { message_id: 6, chat: { id: -9, type: 'supergroup', title: 'Fans' }, from: { id: 3, first_name: 'A' }, text: 'q' } })[0]).toMatchObject({ conversationKind: 'comment', subject: 'Fans' });
    expect(p({ update_id: 3, edited_message: { message_id: 5, edit_date: 1_700_000_100, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'hey!' } })[0]).toMatchObject({ type: 'edit', externalId: '42:5' });
    expect(p({ update_id: 4, message: { message_id: 7, chat: { id: -100, type: 'channel' }, from: { id: 3 }, text: 'post' } })).toEqual([]);
    expect(p({ update_id: 5, message: { message_id: 8, chat: { id: 42, type: 'private' }, from: { id: 1, is_bot: true }, text: 'bot' } })).toEqual([]);
    expect(parseTelegramWebhook({ update: {} })).toEqual([]);
  });

  it('Google reviews: review + owner reply + edits; Bluesky: reply vs mention threads', () => {
    const items = reviewItems('accounts/a/locations/l', { reviewId: 'r1', reviewer: { displayName: 'Rita' }, starRating: 'THREE', comment: 'ok', createTime: '2026-11-01T00:00:00Z', updateTime: '2026-11-02T00:00:00Z', reviewReply: { comment: 'thanks', updateTime: '2026-11-03T00:00:00Z' } });
    expect(items.map((i) => i.type)).toEqual(['message', 'edit', 'message']);
    expect(items[0]).toMatchObject({ conversationKind: 'review', threadKey: 'review:r1', meta: { rating: 3 } });
    expect(items[2]).toMatchObject({ direction: 'outbound', externalId: `reply:r1@${Date.parse('2026-11-03T00:00:00Z')}` });
    const reply = bskyItems('did:me', { uri: 'at://x/p/1', cid: 'c1', reason: 'reply', author: { did: 'did:x', handle: 'x.bsky.social' }, record: { text: 'yo', createdAt: '2026-11-01T00:00:00Z', reply: { root: { uri: 'at://me/p/root', cid: 'cr' }, parent: { uri: 'at://me/p/root', cid: 'cr' } } } });
    expect(reply[0]).toMatchObject({ conversationKind: 'comment', threadKey: 'post:at://me/p/root', meta: { root: { uri: 'at://me/p/root' } } });
    expect(bskyItems('did:me', { uri: 'at://x/p/2', cid: 'c2', reason: 'like', author: { did: 'did:x' }, record: { text: '' } })).toEqual([]);
  });
});

describe('stream B reply rules + charges', () => {
  it('WhatsApp: free-form only within 24 h; charges shown before sending', () => {
    expect(whatsAppReplyRules(rules('dm', 'private_message', 23 * H))).toMatchObject({ allowed: true });
    expect(whatsAppReplyRules(rules('dm', 'private_message', 25 * H))).toMatchObject({ allowed: false, code: 'reply_window_closed' });
    expect(whatsAppReplyRules(rules('dm', 'private_message', null))).toMatchObject({ allowed: false });
    const before = new Date('2026-09-30T23:59:59Z');
    const after = new Date('2026-10-01T00:00:00Z');
    const utility = { name: 'x', language: 'en', category: 'utility' as const, params: [] };
    const allowance = (used: number, billed = false) => ({ used, limit: 1000, billed_this_month: billed });
    // Before Meta's 2026-10-01 change: service replies and utility templates inside the window were free.
    expect(whatsAppCharge({ template: null, windowOpen: true, now: before })).toMatchObject({ billable: false, category: 'service' });
    expect(whatsAppCharge({ template: utility, windowOpen: true, now: before })).toMatchObject({ billable: false });
    // H2: from 2026-10-01 a utility template inside the window is charged.
    expect(whatsAppCharge({ template: utility, windowOpen: true, now: after })).toMatchObject({ billable: true, category: 'utility' });
    expect(whatsAppCharge({ template: utility, windowOpen: true })).toMatchObject({ billable: true });
    expect(whatsAppCharge({ template: utility, windowOpen: false, now: before })).toMatchObject({ billable: true, estimate: null });
    expect(whatsAppCharge({ template: { name: 'x', language: 'en', category: 'marketing', params: [] }, windowOpen: true, rates: { marketing: { amount: 0.05, currency: 'GBP' } } })).toMatchObject({ billable: true, estimate: { amount: 0.05, currency: 'GBP' } });
    expect(whatsAppCharge({ template: { name: 'x', language: 'en', category: null, params: [] }, windowOpen: true })).toMatchObject({ billable: true, category: 'marketing' });
    // Service replies: 1,000 free per month per number; unknown usage is never assumed free; Meta's own billing wins.
    expect(whatsAppCharge({ template: null, windowOpen: true, now: after, service: allowance(999) })).toMatchObject({ billable: false, category: 'service' });
    expect(whatsAppCharge({ template: null, windowOpen: true, now: after, service: allowance(1000), rates: { service: { amount: 0.01, currency: 'GBP' } } }))
      .toMatchObject({ billable: true, category: 'service', estimate: { amount: 0.01, currency: 'GBP' } });
    expect(whatsAppCharge({ template: null, windowOpen: true, now: after, service: allowance(3, true) })).toMatchObject({ billable: true });
    expect(whatsAppCharge({ template: null, windowOpen: true, now: after })).toMatchObject({ billable: true });
  });

  it('WhatsApp free-tier month starts at the earliest possible midnight in any time zone (never understates usage)', async () => {
    const { whatsAppServiceMonthStart } = await import('@social-lite/core/contracts/whatsapp-charges');
    // Mid-month: the UTC+14 midnight on the 1st is earliest.
    expect(whatsAppServiceMonthStart(new Date('2026-11-15T12:00:00Z')).toISOString()).toBe('2026-10-31T10:00:00.000Z');
    // First hours of a UTC month: a UTC−12 account is still in the previous month, which started on the 1st at 12:00 UTC.
    expect(whatsAppServiceMonthStart(new Date('2026-11-01T05:00:00Z')).toISOString()).toBe('2026-10-01T12:00:00.000Z');
  });

  it('Instagram, reviews, YouTube, Threads, Bluesky, Telegram modes', () => {
    expect(instagramReplyRules(rules('dm', 'private_message', 25 * H))).toMatchObject({ allowed: false });
    expect(instagramReplyRules(rules('comment', 'private_message', 8 * 24 * H))).toMatchObject({ allowed: false, code: 'reply_window_closed' });
    expect(instagramReplyRules(rules('comment', 'private_message', H, true))).toMatchObject({ allowed: false, code: 'private_reply_used' });
    expect(gbpReplyRules(rules('review', 'public_reply', null))).toMatchObject({ allowed: true });
    expect(gbpReplyRules(rules('review', 'private_message', null))).toMatchObject({ allowed: false, code: 'mode_not_supported' });
    expect(youtubeReplyRules(rules('comment', 'private_message', null)).allowed).toBe(false);
    expect(threadsReplyRules(rules('comment', 'public_reply', null)).allowed).toBe(true);
    expect(blueskyReplyRules(rules('dm', 'private_message', null)).allowed).toBe(true);
    expect(blueskyReplyRules(rules('mention', 'private_message', null)).allowed).toBe(false);
    expect(telegramReplyRules(rules('comment', 'private_message', null)).allowed).toBe(false);
  });

  it('registry: X, LinkedIn and TikTok have no adapter (needs provider approval); moderation never deletes a customer review', () => {
    expect(implementedChannelKinds().sort()).toEqual(['bluesky', 'facebook_page', 'google_business_profile', 'instagram', 'telegram_bot', 'threads', 'whatsapp', 'youtube']);
    expect(getInboxAdapter('x')).toBeNull();
    expect(getInboxAdapter('google_business_profile')!.moderationActions!('review', 'inbound')).toEqual([]);
    expect(getInboxAdapter('whatsapp')!.moderationActions!('dm', 'inbound')).toEqual([]);
  });
});
