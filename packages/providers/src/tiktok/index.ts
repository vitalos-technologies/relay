// TikTok provider: Content Posting API adapter (Direct Post / inbox draft / manual handoff), Login Kit connector,
// simulated API and metrics. See docs/providers/tiktok.md.
export { tiktokAdapter, tiktokManualHandoff, TIKTOK_CONSTRAINTS, TIKTOK_CONSTRAINTS_VERSION, TIKTOK_PRIVACY_LEVELS, TIKTOK_INBOX_HANDOFF, tiktokCreatorSettings, interactionFlags, type TikTokOptions, type TikTokCreatorSettings } from './adapter.js';
export { tiktokConnector, refreshTikTokCredentials, revokeTikTokToken, publishModeFor, TIKTOK_SCOPES } from './oauth.js';
export { tiktokFake } from './fake.js';
export { tiktokMetricsFetcher } from './metrics.js';
export { classifyTikTok, chunkPlan, chunkRange, CHUNK_BYTES } from './api.js';
