// GET /api/admin/care — V3.5 admin summary (stream F): each stream's own admin overview in one call (inbox, listening,
// AI + automation, integrations) + V3.5 audit counts. Counts and states only; no message, mention or prompt text.
import { careAdminSummary } from '@social-lite/services/admin/v35';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => careAdminSummary(ctx));
