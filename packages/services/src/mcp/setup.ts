// Settings → Developer → MCP setup data. Every URL and example is generated from the live configuration
// (mcpConfig: APP_BASE_URL / MCP_RESOURCE_URL / issuer / pre-registered client), never hand-written.
import { BRAND } from '@social-lite/core';
import { MCP_DEFAULT_SCOPES, MCP_PROTOCOL_VERSION, MCP_SCOPES, MCP_SCOPE_LABEL, MCP_SDK_VERSION, MCP_TOOLS, type McpSetupInfo } from '@social-lite/core/contracts/mcp';
import { expectedIssuer } from './auth.js';
import { mcpConfig } from './config.js';

/** Compatibility as evidenced in this repository (tests/integration/mcp.test.ts). Never claims untested clients work. */
export const TESTED_CLIENTS: McpSetupInfo['tested_clients'] = [
  { client: `MCP TypeScript SDK Client + StreamableHTTPClientTransport ${MCP_SDK_VERSION}`, status: 'tested', protocol: MCP_PROTOCOL_VERSION,
    notes: 'Protocol test passes: discovery, tools, resources, prompts, sign-in refusals, publishing.' },
  { client: 'MCP Inspector', status: 'not_tested', protocol: null, notes: '' },
  { client: 'Claude Code (remote HTTP server)', status: 'not_tested', protocol: null, notes: '' },
  { client: 'Claude (web/desktop) custom connectors', status: 'not_tested', protocol: null, notes: 'Needs a public HTTPS endpoint and an OAuth client registered for its redirect URI.' },
  { client: 'ChatGPT connectors', status: 'not_tested', protocol: null, notes: 'Needs a public HTTPS endpoint and an OAuth client registered for its redirect URI.' },
  { client: 'Clients speaking only MCP 2026-07-28 (sessionless)', status: 'unsupported', protocol: '2026-07-28', notes: `Supported versions: ${MCP_PROTOCOL_VERSION}, 2025-06-18 and 2025-03-26.` },
  { client: 'stdio-only clients', status: 'unsupported', protocol: null, notes: 'Relay is a remote (Streamable HTTP) server; no stdio bridge is provided.' },
];

export function mcpSetupInfo(): McpSetupInfo {
  const cfg = mcpConfig();
  const issuer = expectedIssuer();
  const url = cfg.resourceUrl;
  const clientId = cfg.publicClientId;
  const name = BRAND.name.toLowerCase();
  const examples: McpSetupInfo['examples'] = [
    { id: 'claude-code', label: 'Claude Code', language: 'shell', body: `claude mcp add --transport http ${name} ${url}` },
    { id: 'vscode', label: 'VS Code (.vscode/mcp.json)', language: 'json', body: JSON.stringify({ servers: { [name]: { type: 'http', url } } }, null, 2) },
    { id: 'generic', label: 'Generic (mcpServers)', language: 'json', body: JSON.stringify({ mcpServers: { [name]: { type: 'http', url } } }, null, 2) },
    { id: 'oauth', label: 'OAuth client', language: 'text', body: [
      `Resource: ${url}`,
      `Protected resource metadata: ${cfg.prmUrl}`,
      `Authorization server: ${issuer ?? 'not configured'}`,
      clientId ? `Pre-registered public client: ${clientId} (authorization code + PKCE S256)` : 'Pre-registered public client: none',
      `Dynamic client registration: ${cfg.dcrEnabled ? 'enabled' : 'not enabled'}`,
      `Default scopes: ${MCP_DEFAULT_SCOPES.join(' ')}`,
    ].join('\n') },
    { id: 'api-key', label: 'Scripted client (API key)', language: 'shell', body: [
      `curl -s ${url} \\`,
      `  -H 'Authorization: Bearer <service-account API key>' \\`,
      `  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \\`,
      `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${MCP_PROTOCOL_VERSION}","capabilities":{},"clientInfo":{"name":"script","version":"1"}}}'`,
    ].join('\n') },
    { id: 'discovery', label: 'Check discovery', language: 'shell', body: `curl -s ${cfg.prmUrl}` },
  ];
  return {
    endpoint: url,
    resource: url,
    protected_resource_metadata: cfg.prmUrl,
    authorization_server: issuer,
    protocol_version: MCP_PROTOCOL_VERSION,
    sdk_version: MCP_SDK_VERSION,
    scopes: MCP_SCOPES.map((scope) => ({ scope, label: MCP_SCOPE_LABEL[scope] })),
    default_scopes: MCP_DEFAULT_SCOPES,
    preregistered_client_id: clientId,
    dynamic_client_registration: cfg.dcrEnabled,
    tools: MCP_TOOLS,
    examples,
    tested_clients: TESTED_CLIENTS,
  };
}
