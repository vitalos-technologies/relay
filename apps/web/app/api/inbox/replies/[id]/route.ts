// GET /api/inbox/replies/:id — one send attempt (poll for its result).
import { getAttempt } from '@social-lite/services/inbox/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getAttempt(ctx, params.id));
