// GET /api/listening/sources?brand_id= — coverage registry (connected + broad sources, channels, monitoring start)
import { listeningSources } from '@social-lite/services/listening/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listeningSources(ctx, queryOf(req)));
