// GET /api/inbox/messages/:id/attachments/:idx — an inbound attachment, fetched safely on first open, always served as a
// download (no inline rendering, nosniff, private cache). Authorization is checked on every request.
import { openAttachment } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string; idx: string }>(async ({ ctx, params }) => {
  const f = await openAttachment(ctx, params.id, Number(params.idx));
  return new Response(new Uint8Array(f.bytes), { headers: {
    'content-type': f.mime, 'content-length': String(f.bytes.byteLength), 'content-disposition': `attachment; filename="${f.filename}"`,
    'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox",
  } });
});
