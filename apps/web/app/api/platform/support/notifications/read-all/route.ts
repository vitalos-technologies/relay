// V4 Platform → Support — POST /api/platform/support/notifications/read-all.
import { markAllPlatformNotificationsRead } from '@social-lite/services/support/notify';
import { platformRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = platformRoute(async ({ p }) => markAllPlatformNotificationsRead(p));
