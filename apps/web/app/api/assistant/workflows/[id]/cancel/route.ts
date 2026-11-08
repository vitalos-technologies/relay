// POST /api/assistant/workflows/:id/cancel — stop: undispatched work never starts; finished work is kept and explained.
import { cancelWorkflowRun } from '@social-lite/services/ai-workflows/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => cancelWorkflowRun(ctx, params.id));
