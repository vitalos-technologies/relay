// YouTube provider: Data API v3 adapter (resumable upload, explicit privacy, native scheduling), Google OAuth
// connector, simulated API and Analytics metrics. See docs/providers/youtube.md.
export { youtubeAdapter, setYouTubeThumbnail, youtubeWatchUrl, YOUTUBE_CONSTRAINTS, YOUTUBE_CONSTRAINTS_VERSION, type YouTubeOptions } from './adapter.js';
export { youtubeConnector, refreshYouTubeCredentials, revokeYouTubeToken, YOUTUBE_SCOPES, YOUTUBE_REQUIRED_SCOPES, YT_SCOPE_FORCE_SSL } from './oauth.js';
export { youtubeFake } from './fake.js';
export { youtubeMetricsFetcher } from './metrics.js';
export { classifyYouTube, YT_CHUNK_BYTES } from './api.js';
