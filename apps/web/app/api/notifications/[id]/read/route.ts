// POST /api/notifications/:id/read
import { markNotificationRead } from '@social-lite/services/audit-read';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => {
  await markNotificationRead(ctx, params.id);
  return { ok: true };
});
