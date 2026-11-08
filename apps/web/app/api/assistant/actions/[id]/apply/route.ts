// POST /api/assistant/actions/:id/apply → applies a proposed action through the normal service (permission re-checked).
import { applyAction } from '@social-lite/services/assistant/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => applyAction(ctx, params.id));
