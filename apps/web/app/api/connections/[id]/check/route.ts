// POST /api/connections/:id/check — fresh provider health check.
import { checkConnection } from '@social-lite/services/connections/index';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => checkConnection(ctx, params.id));
