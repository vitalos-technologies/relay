// GET /api/assistant/workflows/:id?after=<seq> — run state (steps, results, actions) + progress events after the cursor.
import { getWorkflowRun } from '@social-lite/services/ai-workflows/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => getWorkflowRun(ctx, params.id, queryOf(req)));
