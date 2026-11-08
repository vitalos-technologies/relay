// GET /api/inbox/counts — per-queue counts for the caller's inbox brands.
import { inboxCounts } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => inboxCounts(ctx));
