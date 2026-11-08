// POST /api/connections/:id/disconnect => { connection, blocked_deliveries } (AC-05; credential deleted immediately).
import { disconnectConnection } from '@social-lite/services/connections/index';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => disconnectConnection(ctx, params.id));
