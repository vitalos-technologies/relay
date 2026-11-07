// POST /api/admin/collaboration/notifications/:id/retry — retry a failed / unconfigured email (recipient re-checked).
import { retryNotificationEmail } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => retryNotificationEmail(ctx, params.id));
