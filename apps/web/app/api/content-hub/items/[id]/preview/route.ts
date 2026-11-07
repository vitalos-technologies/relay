// GET /api/content-hub/items/:id/preview?kind=file|document&mode=exclude|accept|inline — authorized import preview.
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => {
  const q = req.nextUrl.searchParams;
  if (q.get('kind') === 'file') return ch.previewDriveFile(ctx, params.id);
  const mode = q.get('mode');
  return ch.previewDocument(ctx, params.id, mode === 'accept' || mode === 'inline' ? mode : 'exclude');
});
