// GET /api/audit?cursor=&resource_type=&limit= (owner/admin) — { items, next_cursor }
import { listAudit } from '@social-lite/services/audit-read';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const sp = req.nextUrl.searchParams;
  const limit = sp.get('limit');
  return listAudit(ctx, { cursor: sp.get('cursor'), resource_type: sp.get('resource_type'), limit: limit && /^\d{1,3}$/.test(limit) ? Number(limit) : null });
});
