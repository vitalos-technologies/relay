// GET /api/mcp/audit?client_row_id=&cursor=&limit= — MCP call audit (own clients; whole workspace with audit.read).
import { listMcpAudit } from '@social-lite/services/mcp/registry';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const q = req.nextUrl.searchParams;
  return listMcpAudit(ctx, { client_row_id: q.get('client_row_id'), cursor: q.get('cursor'), limit: Number(q.get('limit')) || null });
});
