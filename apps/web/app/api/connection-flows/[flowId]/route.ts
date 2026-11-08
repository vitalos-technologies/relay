// GET /api/connection-flows/:flowId — destinations offered by an OAuth authorization (initiating user only).
import { getConnectionFlow } from '@social-lite/services/connections/index';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ flowId: string }>(async ({ ctx, params }) => getConnectionFlow(ctx, params.flowId));
