// GET /api/platform/ai — Platform → AI operations: workflow runs, outcomes, failed steps, usage per workspace.
// Operational metadata only (no titles, prompts, documents, messages or generated text). Any platform role.
import { platformAiOverview } from '@social-lite/services/ai-workflows/index';
import { platformRoute } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = platformRoute(async ({ p }) => platformAiOverview(p));
