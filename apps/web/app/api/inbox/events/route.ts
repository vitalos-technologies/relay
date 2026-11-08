// GET /api/inbox/events?after=<id> — content-free change feed (poll); clients refetch what changed.
import { inboxEvents } from '@social-lite/services/inbox/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => inboxEvents(ctx, queryOf(req)));
