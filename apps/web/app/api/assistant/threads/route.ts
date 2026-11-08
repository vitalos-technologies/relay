// GET /api/assistant/threads?cursor=&limit=&q= — my AI conversations, newest first, loaded incrementally (keyset cursor).
import { listThreads } from '@social-lite/services/ai-workflows/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listThreads(ctx, queryOf(req)));
