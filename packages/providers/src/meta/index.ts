// OWNED BY: Meta provider workstream. Facebook Page + Instagram (Facebook Login route) adapters.
// See docs/providers/meta.md for verified facts, scopes, error table and limits.
export { facebookAdapter } from './facebook.js';
export { instagramAdapter } from './instagram.js';
export { facebookConnector, instagramConnector } from './connector.js';
export { metaFake } from './fake.js';
// V3.5 inbox (Messenger + Page comments).
export { facebookInboxAdapter, parseFacebookWebhook, facebookReplyRules, FACEBOOK_INBOX_SCOPES, FACEBOOK_PAGE_CAPABILITY } from './inbox.js';
export { recordSimulatedInbound } from './inbox-fake.js';
