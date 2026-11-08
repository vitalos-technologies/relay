// Per-channel inbox capability record (brief §10). Source of truth for the Inbox → Channels settings page and mirrored
// in docs/v3-5/CAPABILITY_MATRIX.md. "supported" means the provider offers it via an official API; whether Relay has
// implemented it is a separate column (`implemented`). Checked against official docs on 2026-11-07 unless noted.
import type { ChannelCapability, ChannelKind } from '@social-lite/core/contracts/v35-inbox';
import { FACEBOOK_PAGE_CAPABILITY } from '@social-lite/providers/meta/inbox';
import { getInboxAdapter, implementedChannelKinds } from '@social-lite/providers';

const V = '2026-11-07';

export const CHANNEL_CAPABILITIES: Record<ChannelKind, ChannelCapability> = {
  facebook_page: FACEBOOK_PAGE_CAPABILITY,
  instagram: {
    kind: 'instagram',
    conversationTypes: {
      dm: { read: 'needs_approval', reply: 'needs_approval', visibility: 'private' },
      comment: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' },
      mention: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' },
    },
    inbound: 'webhook_and_polling', history: 'Conversations API and media comments (recent).',
    replyWindow: 'DMs: 24 h after the customer’s last message (Human Agent: 7 days, needs approval).',
    attachments: 'Images/video in DMs (provider limits apply).', moderation: ['Hide/delete comments'], receipts: { delivered: false, read: true },
    requires: ['Instagram professional account', 'Meta App Review: instagram_business_manage_messages / instagram_manage_messages, instagram_manage_comments (Advanced Access for accounts you do not own)', 'Escalation path to a human agent'],
    verifiedOn: V,
  },
  telegram_bot: {
    kind: 'telegram_bot',
    conversationTypes: {
      dm: { read: 'supported', reply: 'supported', visibility: 'private' },
      comment: { read: 'supported', reply: 'supported', visibility: 'public' },
    },
    inbound: 'webhook', history: 'None: updates are kept by Telegram for 24 h only and cannot be re-fetched later.',
    replyWindow: null, attachments: 'Photos, documents, voice (Bot API file limits).', moderation: ['Delete messages in groups where the bot is admin'],
    receipts: { delivered: false, read: false },
    requires: ['Bot token (no review)', 'Only chats where people message the bot or groups it is in (privacy mode limits group messages)', 'One update consumer per bot: Relay never overwrites an existing webhook or polling integration'],
    verifiedOn: V,
  },
  whatsapp: {
    kind: 'whatsapp',
    conversationTypes: { dm: { read: 'needs_approval', reply: 'needs_approval', visibility: 'private' } },
    inbound: 'webhook', history: 'None via API (webhooks only).',
    replyWindow: 'Free-form replies only within 24 h of the customer’s last message; otherwise an approved template (charged per message).',
    attachments: 'Media messages (provider limits).', moderation: [], receipts: { delivered: true, read: true },
    requires: ['WhatsApp Business Account + registered phone number', 'Meta Business verification', 'Per-message pricing since 2025-07-01; payment method required', 'Template approval for messages outside the window'],
    verifiedOn: V,
  },
  google_business_profile: {
    kind: 'google_business_profile',
    conversationTypes: { review: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' } },
    inbound: 'webhook_and_polling', history: 'All reviews of a location (paginated list).', replyWindow: null,
    attachments: 'None.', moderation: ['Update or delete the owner reply (not the customer’s review)'], receipts: { delivered: false, read: false },
    requires: ['Business Profile API access approval (quota 0 until approved)', 'Verified location managed by the connected account', 'Pub/Sub topic for review notifications (optional; polling otherwise)', 'Chat was discontinued in July 2024'],
    verifiedOn: V,
  },
  x: {
    kind: 'x',
    conversationTypes: {
      dm: { read: 'needs_approval', reply: 'needs_approval', visibility: 'private' },
      mention: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' },
    },
    inbound: 'polling', history: 'Recent mentions/DM events within API limits.', replyWindow: null,
    attachments: 'Media via upload API.', moderation: ['Hide replies'], receipts: { delivered: false, read: false },
    requires: ['Paid API access (pay-per-use credits since 2026; Basic plan closed to new sign-ups)', 'App permission level: Read + write + Direct Messages', 'Per-request charges and monthly read caps — verify current rates in the X console'],
    verifiedOn: V,
  },
  youtube: {
    kind: 'youtube',
    conversationTypes: { comment: { read: 'supported', reply: 'supported', visibility: 'public' } },
    inbound: 'polling', history: 'Comment threads per video (commentThreads.list).', replyWindow: null,
    attachments: 'None.', moderation: ['Set moderation status / reject (channel owner)'], receipts: { delivered: false, read: false },
    requires: ['youtube.force-ssl scope (Google verification for sensitive scopes)', 'Quota: comments.insert costs 50 units of the 10,000/day default'],
    verifiedOn: V,
  },
  linkedin: {
    kind: 'linkedin',
    conversationTypes: { comment: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' } },
    inbound: 'polling', history: 'Comments on organization posts.', replyWindow: null, attachments: 'None.', moderation: ['Delete comments (organization admins)'],
    receipts: { delivered: false, read: false },
    requires: ['LinkedIn Community Management API approval (organization pages; separate developer app)', 'No messaging API for page inboxes'],
    verifiedOn: V,
  },
  threads: {
    kind: 'threads',
    conversationTypes: {
      comment: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' },
      mention: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' },
      dm: { read: 'not_available', reply: 'not_available', visibility: 'private' },
    },
    inbound: 'webhook_and_polling', history: 'Replies to the account’s own posts.', replyWindow: null, attachments: 'Text/image replies via publishing API.',
    moderation: ['Hide/unhide replies', 'Approve/ignore pending replies'], receipts: { delivered: false, read: false },
    requires: ['Meta App Review: threads_read_replies, threads_manage_replies (and threads_manage_mentions for mentions)', 'No DM API'],
    verifiedOn: V,
  },
  bluesky: {
    kind: 'bluesky',
    conversationTypes: {
      mention: { read: 'supported', reply: 'supported', visibility: 'public' },
      comment: { read: 'supported', reply: 'supported', visibility: 'public' },
      dm: { read: 'supported', reply: 'supported', visibility: 'private' },
    },
    inbound: 'polling', history: 'Notifications (mentions, replies) and chat conversations.', replyWindow: null, attachments: 'Images in posts.',
    moderation: ['Thread gates; no comment deletion of others'], receipts: { delivered: false, read: true },
    requires: ['App password; DMs need an app password created with direct-message access (re-verify before build)'],
    verifiedOn: '2026-11-07 (prior knowledge; official endpoint docs moved — re-verify)',
  },
  tiktok: {
    kind: 'tiktok',
    conversationTypes: {
      comment: { read: 'needs_approval', reply: 'needs_approval', visibility: 'public' },
      dm: { read: 'not_available', reply: 'not_available', visibility: 'private' },
    },
    inbound: 'polling', history: 'Comments on business-account videos (recent; limits apply).', replyWindow: 'Third-party reports a 48 h reply limit for organic comments (unconfirmed in official docs).',
    attachments: 'None.', moderation: ['Hide/delete comments (business accounts)'], receipts: { delivered: false, read: false },
    requires: ['TikTok API for Business (business account) approval — not the Content Posting API Relay uses today', 'No DM API for third parties'],
    verifiedOn: '2026-11-07 (third-party sources only; official docs not reachable — re-verify)',
  },
};

// Stream B: implemented networks use their adapter's own capability record (verified when the adapter was built).
for (const k of implementedChannelKinds()) {
  const c = getInboxAdapter(k)?.capability();
  if (c) CHANNEL_CAPABILITIES[k] = c;
}

export function capabilityMatrix(): Array<ChannelCapability & { implemented: boolean; live_requires_approval: boolean }> {
  const impl = new Set(implementedChannelKinds());
  return Object.values(CHANNEL_CAPABILITIES).map((c) => ({
    ...c, implemented: impl.has(c.kind),
    // Built in Relay, but the provider must approve access before real (non-simulated) use.
    live_requires_approval: impl.has(c.kind) && Object.values(c.conversationTypes).some((t) => t && (t.read === 'needs_approval' || t.reply === 'needs_approval')),
  }));
}
