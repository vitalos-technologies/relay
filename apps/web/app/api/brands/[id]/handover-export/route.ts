// POST /api/brands/:id/handover-export { format?: 'zip' | 'json' } → the brand's handover bundle
// (content, revisions, delivery history, assets with 15-minute signed links). Needs exports.create on
// this brand; rate-limited (3/hour), budgeted, audited.
import { z } from 'zod';
import { handoverExport } from '@social-lite/services/product/handover';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => {
  const r = await handoverExport(ctx, params.id, await parseJson(req, z.unknown()));
  return new Response(new Uint8Array(r.body), {
    headers: { 'content-type': r.contentType, 'content-disposition': `attachment; filename="${r.filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
});
