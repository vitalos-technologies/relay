// GET /api/mcp/jobs/:id/download — CSV produced by an MCP report export (signed-in, exports.create on the brand).
import { downloadJob } from '@social-lite/services/mcp/jobs';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ params, ctx }) => {
  const f = await downloadJob(ctx, params.id);
  return new Response(f.csv, { headers: {
    'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${f.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'cache-control': 'no-store',
  } });
});
