// POST /api/connections/:id/pause { paused }
import { pauseSchema, setConnectionPaused } from '@social-lite/services/connections/index';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => setConnectionPaused(ctx, params.id, await parseJson(req, pauseSchema)));
