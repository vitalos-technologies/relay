// GET /api/analytics/exports/:id/download — the file, after re-checking the requester's CURRENT access.
import { downloadReportExport } from '@social-lite/services/analytics/reports';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ exportId: string }>(async ({ ctx, params }) => {
  const f = await downloadReportExport(ctx, params.exportId);
  const safe = f.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(new Uint8Array(f.body), { headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${safe}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
});
