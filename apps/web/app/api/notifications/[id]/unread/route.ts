// POST /api/notifications/:id/unread — mark one notification unread again.
import { markNotificationUnread } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => markNotificationUnread(ctx, params.id));
