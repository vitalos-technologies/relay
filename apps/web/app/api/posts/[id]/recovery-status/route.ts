// GET /api/posts/:id/recovery-status?base_version=N — call before offering to sync recovered local content.
import { recoveryStatus } from '@social-lite/services/data/drafts';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => {
  const v = req.nextUrl.searchParams.get('base_version');
  const n = v && /^\d{1,9}$/.test(v) ? Number(v) : null;
  return recoveryStatus(ctx, params.id, n);
});
