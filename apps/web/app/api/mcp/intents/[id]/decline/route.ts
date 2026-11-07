// POST /api/mcp/intents/:id/decline — refuse an intent (it can never be committed).
import { declineIntent } from '@social-lite/services/mcp/intents';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ params, ctx }) => declineIntent(ctx, params.id));
