// OAuth 2.0 Protected Resource Metadata (RFC 9728 §3.1) for the /mcp resource (path-inserted well-known URI,
// referenced by resource_metadata in the endpoint's WWW-Authenticate challenges).
import { protectedResourceMetadata } from '@social-lite/services/mcp/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return Response.json(protectedResourceMetadata(), { headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
}
