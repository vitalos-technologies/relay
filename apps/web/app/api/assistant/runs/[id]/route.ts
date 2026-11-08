// GET /api/assistant/runs/:id → run with evidence, suggestions, sources and proposed actions (requester only).
import { getRun } from '@social-lite/services/assistant/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getRun(ctx, params.id));
