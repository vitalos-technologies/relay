// POST /api/assistant/workflows/:id/retry — resume a failed/partial/cancelled run; completed writes are never repeated.
import { retryWorkflowRun } from '@social-lite/services/ai-workflows/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => retryWorkflowRun(ctx, params.id));
