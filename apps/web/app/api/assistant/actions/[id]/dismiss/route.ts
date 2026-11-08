// POST /api/assistant/actions/:id/dismiss
import { dismissAction } from '@social-lite/services/assistant/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => dismissAction(ctx, params.id));
