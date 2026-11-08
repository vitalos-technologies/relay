// V4 Platform → Support — GET /api/platform/support/notifications?unread=1: the caller's platform-scope (staff) notifications.
import { listPlatformNotifications } from '@social-lite/services/support/notify';
import { platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ req, p }) => listPlatformNotifications(p, { unread: req.nextUrl.searchParams.get('unread') === '1' }));
