// POST /api/assistant/workflows {workflow, thread_id?, prompt?, inputs, idempotency_key} — QUEUES a workflow run
// ('ai-assist' queue, worker executes it). Never publishes or sends: external actions are only prepared as previews.
import { createWorkflowRun, workflowRequestSchema } from '@social-lite/services/ai-workflows/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => createWorkflowRun(ctx, await parseJson(req, workflowRequestSchema)));
