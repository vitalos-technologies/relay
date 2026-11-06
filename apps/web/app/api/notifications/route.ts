// GET /api/notifications?unread=1 — { items, unread_count }
import { listNotifications } from '@social-lite/services/audit-read';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listNotifications(ctx, { unread: req.nextUrl.searchParams.get('unread') === '1' }));
