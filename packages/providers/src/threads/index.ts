// Threads provider: container → publish adapter, Threads OAuth connector (own app; no Facebook Login reuse),
// simulated API, insights. See docs/providers/threads.md.
export { threadsAdapter, THREADS_CONSTRAINTS, THREADS_CONSTRAINTS_VERSION } from './adapter.js';
export { threadsConnector, refreshThreadsCredentials, THREADS_SCOPES } from './oauth.js';
export { threadsFake } from './fake.js';
export { threadsMetricsFetcher, parseThreadsInsights } from './metrics.js';
export { classifyThreads, threadsTextLength } from './api.js';
