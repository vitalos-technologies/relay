// GET /api/admin/webhooks — V3.1 Admin read model (stored data only; see services/admin/reads.ts for permissions).
import { adminWebhookReceipts } from '@social-lite/services/admin/reads';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => adminWebhookReceipts(ctx));
