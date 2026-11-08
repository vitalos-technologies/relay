// GET /api/assistant/actions/:id/preview — exact destinations, content, timing and permission for a prepared external
// action, with the hash the confirmation must carry (POST /api/assistant/actions/:id/apply {reviewed_hash}).
import { previewAction } from '@social-lite/services/ai-workflows/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => previewAction(ctx, params.id));
