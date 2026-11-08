// POST /api/listening/actions { action: task|case|draft, observation_id|alert_id|search_id, idempotency_key } — insight → work
import { createFromInsight, insightActionSchema } from '@social-lite/services/listening/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => createFromInsight(ctx, await parseJson(req, insightActionSchema)));
