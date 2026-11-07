// Re-exports of the official MCP SDK client (resolved from this package's pinned @modelcontextprotocol/sdk 1.32.2)
// for the in-repo protocol tests (tests/integration/mcp.test.ts) and scripted Relay clients.
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
export { OAuthProtectedResourceMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
export { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
