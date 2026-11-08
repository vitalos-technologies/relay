// POST /api/assistant/workflows/:id/input {field, value} — answer a needs_input question (only the offered options).
import { answerSchema, answerWorkflowRun } from '@social-lite/services/ai-workflows/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => answerWorkflowRun(ctx, params.id, await parseJson(req, answerSchema)));
