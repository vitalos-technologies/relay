// GET /api/content-hub/connections → ContentConnectionDto[] visible to the caller (including disconnected, for history).
import { listContentConnections } from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => listContentConnections(ctx, { includeDisconnected: true }));
