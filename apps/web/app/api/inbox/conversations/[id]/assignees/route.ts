// GET /api/inbox/conversations/:id/assignees — people with inbox access on the conversation's brand (bounded).
import { assigneeOptions } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => assigneeOptions(ctx, params.id));
