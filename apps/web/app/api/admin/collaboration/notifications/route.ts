// GET /api/admin/collaboration/notifications?state=failed|not_configured|skipped|pending&cursor= — delivery problems (metadata only).
import { notificationDiagnostics } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => notificationDiagnostics(ctx, { state: req.nextUrl.searchParams.get('state'), cursor: req.nextUrl.searchParams.get('cursor') }));
