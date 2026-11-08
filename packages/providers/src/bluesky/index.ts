// Bluesky provider: AT Protocol adapter (text + up to 4 images, rich-text facets, deterministic TID record keys),
// app-password connector (clearly labelled; atproto OAuth not yet implemented), simulated API and post counts.
// See docs/providers/bluesky.md.
export { blueskyAdapter, postRecord as blueskyPostRecord, bskyPostUrl, BLUESKY_CONSTRAINTS, BLUESKY_CONSTRAINTS_VERSION, type BlueskyOptions } from './adapter.js';
export { blueskyConnector, refreshBlueskyCredentials, APP_PASSWORD_RE, type BlueskyConnector } from './connector.js';
export { blueskyFake, FAKE_PDS } from './fake.js';
export { blueskyMetricsFetcher } from './metrics.js';
export { classifyBluesky, deliveryTid, tid, TID_RE, pdsFromDidDoc, jwtExpiry, BSKY_ENTRYWAY } from './api.js';
export { detectFacets, buildFacets, type Facet } from './richtext.js';
