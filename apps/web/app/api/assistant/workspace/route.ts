// GET /api/assistant/workspace?brand_id= — V5 AI workspace context (brands, accounts, documents, permissions, plan
// features, data availability) + 4–6 suggestions derived from it. Read with the caller's own access; titles/counts only.
import { workspaceContext } from '@social-lite/services/ai-workflows/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => workspaceContext(ctx, queryOf(req)));
