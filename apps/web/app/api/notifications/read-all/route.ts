// POST /api/notifications/read-all
import { markAllNotificationsRead } from '@social-lite/services/audit-read';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ ctx }) => {
  await markAllNotificationsRead(ctx);
  return { ok: true };
});
