// LinkedIn provider: versioned REST Posts API adapter (member vs organization), OAuth connector, simulated API,
// metrics. See docs/providers/linkedin.md.
export { linkedinAdapter, linkedinPostUrl, postBody as linkedinPostBody, LINKEDIN_CONSTRAINTS, LINKEDIN_CONSTRAINTS_VERSION, type LinkedInOptions } from './adapter.js';
export { linkedinConnector, refreshLinkedInCredentials, linkedinScopes, LI_MEMBER_SCOPES, LI_ORG_SCOPES } from './oauth.js';
export { linkedinFake } from './fake.js';
export { linkedinMetricsFetcher } from './metrics.js';
export { classifyLinkedIn, littleEscape, littleUnescape, LI_DEFAULT_VERSION } from './api.js';
