// /mcp — Relay MCP endpoint (Streamable HTTP, MCP revision 2025-11-25, @modelcontextprotocol/sdk 1.32.2).
// All protocol, authentication (OAuth bearer / API key), Origin/Host validation, sessions and limits live in
// packages/services/src/mcp/server.ts; this file only binds HTTP methods. No cookies are read here.
import { handleMcpHttp } from '@social-lite/services/mcp/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const handle = (req: Request) => handleMcpHttp(req);
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;
