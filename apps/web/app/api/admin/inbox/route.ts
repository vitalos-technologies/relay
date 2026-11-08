// GET /api/admin/inbox — inbox + connector health for the workspace admin console (counts/states only; no message text).
import { inboxAdminOverview } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => inboxAdminOverview(ctx));
