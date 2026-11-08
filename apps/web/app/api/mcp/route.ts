// GET /api/mcp — Settings → Developer → MCP overview: setup (generated from live config) + clients visible to the caller.
import { mcpOverview } from '@social-lite/services/mcp/registry';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => mcpOverview(ctx));
