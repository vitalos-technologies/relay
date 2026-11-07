// OAuth 2.0 Protected Resource Metadata (RFC 9728) — root well-known URI (fallback for MCP clients).
import { protectedResourceMetadata } from '@social-lite/services/mcp/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return Response.json(protectedResourceMetadata(), { headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
}
