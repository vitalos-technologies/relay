// GET /api/assistant/runs?context_id=&limit= (my runs) · POST {surface, task, context, prompt?, target_language?, idempotency_key}
// POST only queues the run (ai-assist queue); poll GET /api/assistant/runs/:id. Never sends, publishes or changes anything.
import { createRun, listRuns, runRequestSchema } from '@social-lite/services/assistant/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listRuns(ctx, queryOf(req) as never));
export const POST = route(async ({ req, ctx }) => createRun(ctx, await parseJson(req, runRequestSchema)));
