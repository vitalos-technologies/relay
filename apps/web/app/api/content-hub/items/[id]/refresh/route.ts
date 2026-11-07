// POST /api/content-hub/items/:id/refresh → ImportDto (queued; diff + new draft revision when the worker runs).
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => ch.requestRefresh(ctx, params.id, req.headers.get('idempotency-key')));
