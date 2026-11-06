// GET /api/brands/:id/connections — connections of a brand (credentials are never returned).
import { listConnections } from '@social-lite/services/connections/index';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => listConnections(ctx, params.id));
