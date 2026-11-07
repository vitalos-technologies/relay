// GET /api/comments/:id/history — previous versions of an edited comment (anyone who can see it).
import { commentHistory } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => commentHistory(ctx, params.id));
