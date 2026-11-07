// Pinterest provider: API v5 adapter (boards → Pins, video media upload), OAuth connector, simulated API, Pin
// analytics. See docs/providers/pinterest.md.
export { pinterestAdapter, pinBody, pinUrl, PINTEREST_CONSTRAINTS, PINTEREST_CONSTRAINTS_VERSION, type PinterestOptions } from './adapter.js';
export { pinterestConnector, refreshPinterestCredentials, PINTEREST_SCOPES } from './oauth.js';
export { pinterestFake } from './fake.js';
export { pinterestMetricsFetcher } from './metrics.js';
export { classifyPinterest } from './api.js';
