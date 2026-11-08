// GET /api/assistant/admin — Workspace admin: AI workflow runs, failures, usage, budget, feature availability (diagnostics.read).
import { aiWorkflowAdmin } from '@social-lite/services/ai-workflows/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => aiWorkflowAdmin(ctx));
